/** Regression tests for the four high-severity review findings fixed before the first live run. */
import { describe, expect, it } from "vitest";
import { AmbiguousCreateError, ExaEngine } from "../src/engines/exa.js";
import { Limiter, TimeoutError } from "../src/util.js";
import { buildToolset } from "../src/worker/tools.js";
import { LONG_TEXT, fakeExaClient, harness } from "./helpers.js";

const noSleep = { sleepFn: async () => {} };
const never = () => new Promise<never>(() => {});

describe("H2: creating a paid Exa Agent run is never retried", () => {
  it("a 502 on create is one attempt and surfaces as ambiguous", async () => {
    const client = fakeExaClient({ create: () => { throw Object.assign(new Error("bad gateway"), { statusCode: 502 }); } });
    const err = await new ExaEngine(client, { retry: noSleep }).agentCreate({ query: "q", effort: "high" }).catch((e) => e);
    expect(err).toBeInstanceOf(AmbiguousCreateError);
    expect((err as AmbiguousCreateError).nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(client.agent.runs.create).toHaveBeenCalledTimes(1);
  });

  it("a network error on create is one attempt and ambiguous; a 400 is a plain error", async () => {
    const net = fakeExaClient({ create: () => { throw new TypeError("fetch failed"); } });
    await expect(new ExaEngine(net, { retry: noSleep }).agentCreate({ query: "q", effort: "high" })).rejects.toBeInstanceOf(AmbiguousCreateError);
    expect(net.agent.runs.create).toHaveBeenCalledTimes(1);
    const bad = fakeExaClient({ create: () => { throw Object.assign(new Error("invalid schema"), { statusCode: 400 }); } });
    const e = await new ExaEngine(bad, { retry: noSleep }).agentCreate({ query: "q", effort: "high" }).catch((x) => x);
    expect(e).not.toBeInstanceOf(AmbiguousCreateError);
    expect(e.message).toBe("invalid schema");
  });

  it("idempotent calls (get) are still retried", async () => {
    let n = 0;
    const client = fakeExaClient({ get: (id) => { if (++n < 3) throw Object.assign(new Error("busy"), { statusCode: 503 }); return { id, status: "completed" }; } });
    await expect(new ExaEngine(client, { retry: noSleep }).agentGet("r")).resolves.toMatchObject({ status: "completed" });
    expect(n).toBe(3);
  });

  it("Core adopts the run Exa did create when the response was lost", async () => {
    let sentNonce = "";
    const h = harness({
      job: { cap: 2 },
      exa: {
        create: (p) => { sentNonce = (p.metadata as { spurhund_nonce: string }).spurhund_nonce; throw Object.assign(new Error("gateway timeout"), { statusCode: 504 }); },
        list: () => [{ id: "run_other", status: "running", metadata: { spurhund_nonce: "someone-else" } }, { id: "run_mine", status: "running", metadata: { spurhund_nonce: sentNonce } }],
        get: (id) => ({ id, status: "completed", costDollars: { total: 0.4 } }),
      },
    });
    const run = await h.core.agentStart("r1", { query: "q", effort: "high" });
    expect(run.id).toBe("run_mine");
    expect(h.exaClient.agent.runs.create).toHaveBeenCalledTimes(1);
    expect(h.store.getExaRun("run_mine")).toMatchObject({ planRunId: "r1", status: "running" });
    await h.core.agentGet("run_mine");
    expect(h.core.ledger!.spent).toBeCloseTo(0.4); // tracked and settled like any other run
  });

  it("also finds the nonce in the echoed request when Exa returns no top-level metadata", async () => {
    let nonce = "";
    const h = harness({
      job: { cap: 2 },
      exa: {
        create: (p) => { nonce = (p.metadata as { spurhund_nonce: string }).spurhund_nonce; throw new TypeError("socket hang up"); },
        list: () => [{ id: "run_req", status: "running", request: { metadata: { spurhund_nonce: nonce } } }],
      },
    });
    expect((await h.core.agentStart("r1", { query: "q", effort: "medium" })).id).toBe("run_req");
  });

  it("when no run can be found, the worst case is charged and the user is told to check for an orphan", async () => {
    const h = harness({ job: { cap: 2 }, exa: { create: () => { throw Object.assign(new Error("bad gateway"), { statusCode: 502 }); }, list: () => [] } });
    await expect(h.core.agentStart("r1", { query: "q", effort: "high" })).rejects.toThrow(/charged the worst case \(\$0\.50\).*orphaned run/);
    expect(h.core.ledger!.spent).toBeCloseTo(0.5);
    expect(h.store.sumCost(h.core.jobId!, "exa")).toBeCloseTo(0.5);
  });

  it("a plain rejection gives the reservation back", async () => {
    const h = harness({ job: { cap: 2 }, exa: { create: () => { throw Object.assign(new Error("invalid"), { statusCode: 400 }); } } });
    await expect(h.core.agentStart("r1", { query: "q", effort: "high" })).rejects.toThrow("invalid");
    expect(h.core.ledger!.remaining).toBe(2);
  });
});

describe("H3: every Exa call is bounded by a timeout", () => {
  it("a hanging search fails with TimeoutError after the retries instead of hanging forever", async () => {
    const client = fakeExaClient({ search: never });
    const e = new ExaEngine(client, { timeoutMs: 20, retry: { attempts: 2, sleepFn: async () => {} } });
    await expect(e.search({ text: "q", numResults: 1 })).rejects.toBeInstanceOf(TimeoutError);
    expect(client.search).toHaveBeenCalledTimes(2);
  });

  it("frees the limiter slot, so later calls still run", async () => {
    let first = true;
    const client = fakeExaClient({ search: () => { if (first) { first = false; return never(); } return { results: [] }; } });
    const e = new ExaEngine(client, { timeoutMs: 20, limiter: new Limiter(1), retry: { attempts: 1 } });
    await expect(e.search({ text: "q", numResults: 1 })).rejects.toBeInstanceOf(TimeoutError);
    await expect(e.search({ text: "q", numResults: 1 })).resolves.toMatchObject({ results: [] });
  });

  it("a hanging create is one attempt and ambiguous; a hanging poll does not block the run loop", async () => {
    const hangCreate = fakeExaClient({ create: never });
    await expect(new ExaEngine(hangCreate, { timeoutMs: 20, retry: noSleep }).agentCreate({ query: "q", effort: "medium" })).rejects.toBeInstanceOf(AmbiguousCreateError);
    expect(hangCreate.agent.runs.create).toHaveBeenCalledTimes(1);
    const hangGet = fakeExaClient({ get: never });
    await expect(new ExaEngine(hangGet, { timeoutMs: 20, retry: { attempts: 1 } }).agentGet("r")).rejects.toBeInstanceOf(TimeoutError);
  });

  it("a hanging fetch surfaces as an error from Core and the reservation is released", async () => {
    const h = harness({ job: { cap: 1 } });
    const slow = new ExaEngine(fakeExaClient({ getContents: never }), { timeoutMs: 20, retry: { attempts: 1 } });
    const { Core } = await import("../src/core.js");
    const core = new Core({ config: { redact: [], fetchCacheDays: 7, engines: ["exa"] }, store: h.store, engines: { exa: slow }, exa: slow, jobId: h.core.jobId, ledger: h.core.ledger });
    core.seedUserUrls("https://e.com/x");
    await expect(core.fetch({ urls: ["https://e.com/x"] })).rejects.toBeInstanceOf(TimeoutError);
    expect(h.core.ledger!.remaining).toBe(1);
  });
});

describe("H4: 'read' means read in this job", () => {
  async function priorRead() {
    // The page is read once outside the job (ad-hoc fetch), then the job only sees it in a search.
    const h = harness({
      job: { cap: 5 },
      exa: {
        search: () => ({ results: [{ url: "https://vendor.example/advisory", title: "Advisory", highlights: ["h"] }], costDollars: { total: 0.01 } }),
        getContents: (urls) => ({ results: urls.map((url) => ({ url, text: LONG_TEXT })), costDollars: { total: 0.001 } }),
      },
    });
    const { Core } = await import("../src/core.js");
    const adhoc = new Core({ config: { redact: [], fetchCacheDays: 7, engines: ["exa"] }, store: h.store, engines: { exa: h.exa }, exa: h.exa });
    await adhoc.fetch({ urls: ["https://vendor.example/advisory"] });
    const tools = new Map(buildToolset("verify", { core: h.core, store: h.store, jobId: h.core.jobId, segment: "s" }).map((t) => [t.name, t] as const));
    const seg = new Map(buildToolset("segment", { core: h.core, store: h.store, jobId: h.core.jobId, segment: "s" }).map((t) => [t.name, t] as const));
    await seg.get("search")!.handler({ query: "vendor advisory" });
    return { h, tools, seg };
  }

  it("a page read only outside the job does not make a finding 'fetched'", async () => {
    const { h, seg } = await priorRead();
    const r = await seg.get("record_finding")!.handler({ claim: "The vendor fixed it in 2.4.1", sources: ["https://vendor.example/advisory"], source_kind: "primary" });
    expect(r.text).toMatch(/evidence: snippet only/);
    expect(h.store.listFindings(h.core.jobId!)[0]!.evidence).toBe("snippet");
  });

  it("'verified' is refused until the job reads the page itself; then it works and costs nothing extra", async () => {
    const { h, tools, seg } = await priorRead();
    await seg.get("record_finding")!.handler({ claim: "The vendor fixed it in 2.4.1", sources: ["https://vendor.example/advisory"], source_kind: "primary" });
    const id = h.store.listFindings(h.core.jobId!)[0]!.id;

    const listed = await tools.get("list_findings")!.handler({});
    expect(listed.text).toContain("https://vendor.example/advisory [unread]"); // as this job sees it

    const before = await tools.get("set_verification")!.handler({ finding_id: id, status: "verified", note: "n" });
    expect(before.text).toMatch(/set to unverified instead of verified.*no cited page was read in full/s);

    const fetched = await tools.get("fetch")!.handler({ urls: ["https://vendor.example/advisory"] });
    expect(fetched.text).toContain("[READ, cached]"); // served from cache: no second charge
    expect(h.exaClient.getContents).toHaveBeenCalledTimes(1);
    const after = await tools.get("set_verification")!.handler({ finding_id: id, status: "verified", note: "read it" });
    expect(after.text).toBe(`Finding #${id} set to verified.`);
  });
});
