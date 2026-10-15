import { describe, expect, it } from "vitest";
import { Core, NoEngineError } from "../src/core.js";
import { EmptyAfterRedactionError } from "../src/redact.js";
import { LONG_TEXT, harness } from "./helpers.js";

const exaResults = (urls: string[]) => ({
  results: urls.map((url, i) => ({ url, title: `T${i}`, highlights: [`exa snippet ${i}`] })),
  costDollars: { total: 0.01 },
});

describe("Core.search", () => {
  it("queries both engines, merges by canonical URL and records engine provenance", async () => {
    const h = harness({
      exa: { search: () => exaResults(["https://pve.proxmox.com/wiki/Roadmap/", "https://only-exa.com/a"]) },
    });
    const out = await h.core.search({ query: "proxmox 9 roadmap", objective: "official roadmap", numResults: 5 });

    expect(out.engines.map((e) => [e.engine, e.ok])).toEqual([
      ["exa", true],
      ["brave", true],
    ]);
    const both = out.results.find((r) => r.canonicalUrl === "https://pve.proxmox.com/wiki/Roadmap")!;
    expect(both.foundBy.map((f) => f.engine).sort()).toEqual(["brave", "exa"]);
    expect(out.results[0]!.canonicalUrl).toBe(both.canonicalUrl); // found by two engines, ranked first
    expect(out.results).toHaveLength(3);
    expect(out.costUsd).toBeCloseTo(0.01 + 0.005);
    expect(h.exaClient.search.mock.calls[0]![1]).toMatchObject({ objective: "official roadmap" });
  });

  it("still answers when one engine fails and reports the failure", async () => {
    const h = harness({ brave: () => new Response("nope", { status: 401 }), exa: { search: () => exaResults(["https://a.com"]) } });
    const out = await h.core.search({ query: "q" });
    expect(out.results).toHaveLength(1);
    expect(out.engines.find((e) => e.engine === "brave")).toMatchObject({ ok: false, count: 0 });
    expect(out.engines.find((e) => e.engine === "brave")!.error).toMatch(/401/);
  });

  it("throws when every engine fails", async () => {
    const h = harness({
      brave: () => new Response("x", { status: 400 }),
      exa: { search: () => { throw new Error("exa down"); } },
    });
    await expect(h.core.search({ query: "q" })).rejects.toThrow(/All engines failed.*exa down.*400/s);
  });

  it("limits the call to requested engines and says when one is not configured", async () => {
    const h = harness({ engines: ["exa"], exa: { search: () => exaResults(["https://a.com"]) } });
    const out = await h.core.search({ query: "q", engines: ["exa", "brave"] });
    expect(h.brave.fetchImpl).not.toHaveBeenCalled();
    expect(out.engines.find((e) => e.engine === "brave")).toMatchObject({ ok: false });
    expect(out.engines.find((e) => e.engine === "brave")!.error).toMatch(/not configured/);
    expect(out.results).toHaveLength(1);
    // asking for brave only, when it is not configured, is an error
    await expect(h.core.search({ query: "q", engines: ["brave"] })).rejects.toThrow(NoEngineError);
  });

  it("redacts configured terms and secrets before anything leaves the machine", async () => {
    const h = harness({ redact: ["corp.internal"], exa: { search: () => exaResults(["https://a.com"]) } });
    const out = await h.core.search({
      query: "why does pve1.corp.internal fail with key sk-ant-api03-ABCDEFGHIJKLMNOP",
      objective: "ignore corp.internal hosts",
    });
    expect(out.redactions).toBe(3);
    expect(h.exaClient.search.mock.calls[0]![0]).toBe("why does fail with key");
    expect(h.exaClient.search.mock.calls[0]![1]).toMatchObject({ objective: "ignore hosts" });
    expect(new URL(h.brave.fetchImpl.mock.calls[0]![0]).searchParams.get("q")).toBe("why does fail with key");
    expect(h.store.sumCost("none", "exa")).toBe(0);
  });

  it("rejects a query that is empty after redaction", async () => {
    const h = harness({ redact: ["secret"] });
    await expect(h.core.search({ query: "secret" })).rejects.toThrow(EmptyAfterRedactionError);
    expect(h.exaClient.search).not.toHaveBeenCalled();
  });

  it("clamps numResults to 1..25", async () => {
    const h = harness();
    await h.core.search({ query: "q", numResults: 999 });
    await h.core.search({ query: "q", numResults: 0 });
    expect(h.exaClient.search.mock.calls[0]![1]).toMatchObject({ numResults: 25 });
    expect(h.exaClient.search.mock.calls[1]![1]).toMatchObject({ numResults: 1 });
  });

  it("stores sources and hits attributed to the job", async () => {
    const h = harness({ job: { cap: 5 }, exa: { search: () => exaResults(["https://a.com/x"]) } });
    await h.core.search({ query: "q" });
    expect(h.store.jobStats(h.core.jobId!)).toMatchObject({ sources: 3, engineCalls: 2 });
  });
});

describe("Core.search with a job budget", () => {
  it("settles the reservation with the real cost", async () => {
    const h = harness({ job: { cap: 1 }, exa: { search: () => ({ results: [], costDollars: { total: 0.02 } }) } });
    await h.core.search({ query: "q", engines: ["exa"] });
    expect(h.core.ledger!.spent).toBeCloseTo(0.02);
    expect(h.store.sumCost(h.core.jobId!, "exa")).toBeCloseTo(0.02);
  });

  it("refuses Exa when the cap is exhausted but still uses Brave", async () => {
    const h = harness({ job: { cap: 0.001 } });
    const out = await h.core.search({ query: "q" });
    expect(h.exaClient.search).not.toHaveBeenCalled();
    expect(out.engines.find((e) => e.engine === "exa")!.error).toMatch(/budget/i);
    expect(out.engines.find((e) => e.engine === "brave")!.ok).toBe(true);
  });

  it("releases the reservation when the call fails", async () => {
    const h = harness({ job: { cap: 1 }, exa: { search: () => { throw new Error("boom"); } } });
    await h.core.search({ query: "q" }); // brave carries it
    expect(h.core.ledger!.spent).toBe(0);
    expect(h.core.ledger!.remaining).toBe(1);
  });
});

describe("Core.fetch", () => {
  const page = (url: string, text = LONG_TEXT) => ({ results: [{ url, title: "Doc", text }], costDollars: { total: 0.001 } });

  it("fetches, stores the text and serves repeats from the cache", async () => {
    const h = harness({ exa: { getContents: (urls) => page(urls[0]!) } });
    const first = await h.core.fetch({ urls: ["https://e.com/doc"], maxCharacters: 12_000 });
    expect(first.pages[0]).toMatchObject({ status: "read", cached: false, title: "Doc" });
    expect(first.costUsd).toBe(0.001);

    const second = await h.core.fetch({ urls: ["https://www.e.com/doc/#top"] });
    expect(second.pages[0]).toMatchObject({ status: "read", cached: true });
    expect(second.costUsd).toBe(0);
    expect(h.exaClient.getContents).toHaveBeenCalledTimes(1);
  });

  it("refetches a truncated page when more characters are requested", async () => {
    const long = "abcd".repeat(2500); // 10k chars, no whitespace
    const h = harness({ exa: { getContents: (urls, opts) => page(urls[0]!, long.slice(0, (opts.text as { maxCharacters: number }).maxCharacters)) } });
    const a = await h.core.fetch({ urls: ["https://e.com/long"], maxCharacters: 2000 });
    expect(a.pages[0]!.status).toBe("truncated");
    const b = await h.core.fetch({ urls: ["https://e.com/long"], maxCharacters: 2000 });
    expect(b.pages[0]!.cached).toBe(true);
    const c = await h.core.fetch({ urls: ["https://e.com/long"], maxCharacters: 9000 });
    expect(c.pages[0]).toMatchObject({ cached: false, status: "truncated" });
    expect(h.exaClient.getContents).toHaveBeenCalledTimes(2);
  });

  it("fetches only uncached URLs in a mixed batch and keeps request order", async () => {
    const h = harness({
      exa: { getContents: (urls) => ({ results: urls.map((url) => ({ url, text: LONG_TEXT })), costDollars: { total: 0.001 * urls.length } }) },
    });
    await h.core.fetch({ urls: ["https://e.com/a"] });
    const out = await h.core.fetch({ urls: ["https://e.com/b", "https://e.com/a", "https://e.com/b"] });
    expect(out.pages.map((p) => [p.url, p.cached])).toEqual([["https://e.com/b", false], ["https://e.com/a", true]]);
    expect(h.exaClient.getContents.mock.calls[1]![0]).toEqual(["https://e.com/b"]);
  });

  it("does not cache pages that were not read", async () => {
    const h = harness({ exa: { getContents: (urls) => page(urls[0]!, "") } });
    await h.core.fetch({ urls: ["https://e.com/empty"] });
    const again = await h.core.fetch({ urls: ["https://e.com/empty"] });
    expect(again.pages[0]).toMatchObject({ status: "not_read", cached: false });
    expect(h.exaClient.getContents).toHaveBeenCalledTimes(2);
  });

  it("validates input", async () => {
    const h = harness();
    await expect(h.core.fetch({ urls: [] })).rejects.toThrow(/at least one/i);
    await expect(h.core.fetch({ urls: ["file:///etc/passwd"] })).rejects.toThrow(/http\(s\)/);
    await expect(h.core.fetch({ urls: Array.from({ length: 11 }, (_, i) => `https://e.com/${i}`) })).rejects.toThrow(/At most 10/);
  });

  it("clamps maxCharacters", async () => {
    const h = harness({ exa: { getContents: (urls) => page(urls[0]!) } });
    await h.core.fetch({ urls: ["https://e.com/1"], maxCharacters: 10 });
    await h.core.fetch({ urls: ["https://e.com/2"], maxCharacters: 10_000_000 });
    expect(h.exaClient.getContents.mock.calls[0]![1]).toEqual({ text: { maxCharacters: 1000 } });
    expect(h.exaClient.getContents.mock.calls[1]![1]).toEqual({ text: { maxCharacters: 60_000 } });
  });

  it("counts fetch spend against the job cap", async () => {
    const h = harness({ job: { cap: 0.0005 }, exa: { getContents: (urls) => page(urls[0]!) } });
    h.core.seedUserUrls("https://e.com/a https://e.com/b");
    await expect(h.core.fetch({ urls: ["https://e.com/a", "https://e.com/b"] })).rejects.toThrow(/budget/i);
    expect(h.exaClient.getContents).not.toHaveBeenCalled();
  });

  it("fails clearly without Exa", async () => {
    const h = harness();
    const noExa = new Core({
      config: { redact: [], fetchCacheDays: 7, engines: ["brave"] },
      store: h.store,
      engines: { brave: h.brave.engine },
    });
    await expect(noExa.fetch({ urls: ["https://e.com"] })).rejects.toThrow(NoEngineError);
  });
});

describe("Core Exa agent runs", () => {
  it("reserves the worst case, settles the reported cost and persists the run", async () => {
    let polls = 0;
    const h = harness({
      job: { cap: 2 },
      exa: {
        create: () => ({ id: "run_a", status: "running" }),
        get: (id) => (++polls < 2 ? { id, status: "running" } : { id, status: "completed", stopReason: "schema_satisfied", output: { text: "done" }, costDollars: { total: 0.45 } }),
      },
    });
    const run = await h.core.agentStart("r1", { query: "q", effort: "high" });
    expect(run.id).toBe("run_a");
    expect(h.core.ledger!.remaining).toBeCloseTo(1.5); // 0.5 reserved
    expect((await h.core.agentGet("run_a")).status).toBe("running");
    const done = await h.core.agentGet("run_a");
    expect(done.status).toBe("completed");
    expect(h.core.ledger!.spent).toBeCloseTo(0.45);
    expect(h.core.ledger!.remaining).toBeCloseTo(1.55);
    expect(h.store.getExaRun("run_a")).toMatchObject({ status: "completed", stopReason: "schema_satisfied", costUsd: 0.45, output: { text: "done" } });
    expect(h.store.sumCost(h.core.jobId!, "exa")).toBeCloseTo(0.45);
    // reading a finished run again does not double-charge
    await h.core.agentGet("run_a");
    expect(h.core.ledger!.spent).toBeCloseTo(0.45);
  });

  it("refuses to start a run that does not fit the remaining budget", async () => {
    const h = harness({ job: { cap: 0.3 } });
    await expect(h.core.agentStart("r1", { query: "q", effort: "high" })).rejects.toThrow(/budget/i);
    expect(h.exaClient.agent.runs.create).not.toHaveBeenCalled();
  });

  it("gives the reservation back when the run fails to start", async () => {
    const h = harness({ job: { cap: 1 }, exa: { create: () => { throw new Error("400 bad schema"); } } });
    await expect(h.core.agentStart("r1", { query: "q", effort: "high" })).rejects.toThrow("bad schema");
    expect(h.core.ledger!.remaining).toBe(1);
  });

  it("reserves the budget cap for metered runs", async () => {
    const h = harness({ job: { cap: 5 } });
    await h.core.agentStart("r1", { query: "q", effort: "auto", budgetUsd: 3 });
    expect(h.core.ledger!.remaining).toBeCloseTo(2);
  });

  it("stops ultra runs, keeps partial output and settles the cost", async () => {
    const h = harness({
      job: { cap: 10 },
      exa: {
        create: () => ({ id: "run_u", status: "running" }),
        get: (id) => ({ id, status: "completed", stopReason: "stopped", output: { text: "partial" }, costDollars: { total: 1.7 } }),
      },
    });
    await h.core.agentStart("r1", { query: "q", effort: "ultra", budgetUsd: 8, maxDurationSeconds: 900 });
    const ended = await h.core.agentEnd("run_u");
    expect(h.exaClient.agent.runs.stop).toHaveBeenCalledWith("run_u");
    expect(ended.stopReason).toBe("stopped");
    expect(h.core.ledger!.spent).toBeCloseTo(1.7);
    expect(h.store.getExaRun("run_u")!.output).toEqual({ text: "partial" });
  });

  it("charges the worst case when a finished run reports no cost, and nothing for a failed one", async () => {
    const h = harness({
      job: { cap: 5 },
      exa: {
        create: (p) => ({ id: p.query === "ok" ? "run_ok" : "run_bad", status: "running" }),
        get: (id) => (id === "run_ok" ? { id, status: "completed" } : { id, status: "failed", error: { message: "schema rejected" } }),
      },
    });
    await h.core.agentStart("a", { query: "ok", effort: "medium" });
    await h.core.agentStart("b", { query: "bad", effort: "medium" });
    await h.core.agentGet("run_ok");
    await h.core.agentGet("run_bad");
    expect(h.core.ledger!.spent).toBeCloseTo(0.1);
    expect(h.store.getExaRun("run_bad")).toMatchObject({ status: "failed", error: "schema rejected" });
  });

  it("settles immediately when the API returns an already finished run", async () => {
    const h = harness({ job: { cap: 5 }, exa: { create: () => ({ id: "run_i", status: "completed", costDollars: { total: 0.1 }, output: { text: "instant" } }) } });
    await h.core.agentStart("r1", { query: "q", effort: "medium" });
    expect(h.core.ledger!.spent).toBeCloseTo(0.1);
    expect(h.store.getExaRun("run_i")).toMatchObject({ status: "completed", output: { text: "instant" } });
  });
});

describe("Core.resolveSources", () => {
  it("registers cited URLs and de-duplicates them", () => {
    const h = harness();
    const ids = h.core.resolveSources(["https://e.com/a", "https://www.e.com/a#x", "https://e.com/b"]);
    expect(ids).toHaveLength(2);
  });
});

