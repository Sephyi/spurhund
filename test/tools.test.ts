import { describe, expect, it } from "vitest";
import { buildToolset, type Role, type ToolContext, type ToolSpec } from "../src/worker/tools.js";
import { LONG_TEXT, harness, type Harness } from "./helpers.js";

const exaResults = (urls: string[]) => ({ results: urls.map((url) => ({ url, title: url, highlights: ["h"] })), costDollars: { total: 0.01 } });

function setup(role: Role, opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ job: { cap: 5 }, exa: { search: () => exaResults(["https://a.example/one", "https://b.example/two"]), getContents: (urls) => ({ results: urls.map((url) => ({ url, text: LONG_TEXT })), costDollars: { total: 0.001 } }) }, ...opts });
  const ctx: ToolContext = { core: h.core, store: h.store, jobId: h.core.jobId, segment: "seg1" };
  const tools = new Map(buildToolset(role, ctx).map((t) => [t.name, t] as const));
  const call = (name: string, args: Record<string, unknown>) => {
    const t = tools.get(name);
    if (!t) throw new Error(`tool ${name} not in ${role} toolset: ${[...tools.keys()].join(",")}`);
    return t.handler(args);
  };
  return { h, ctx, tools, call };
}

describe("toolsets per role", () => {
  const names = (role: Role) => buildToolset(role, { core: harness().core, store: harness().store }).map((t) => t.name);

  it("keeps search out of the roles that must not search", () => {
    for (const role of ["merge", "report"] as const) expect(names(role)).not.toContain("search");
    expect(names("report")).not.toContain("record_finding");
  });

  it("gives each role only what it needs", () => {
    expect(names("planner")).toEqual(["search"]);
    expect(names("segment")).toEqual(["search", "fetch", "record_finding", "record_gap"]);
    expect(names("merge")).toEqual(["list_findings", "exa_run_output", "record_finding", "merge_findings", "record_gap"]);
    expect(names("gap")).toEqual(["search", "fetch", "list_findings", "record_finding", "record_gap"]);
    expect(names("verify")).toEqual(["list_findings", "fetch", "search", "set_verification", "record_gap"]);
    expect(names("report")).toEqual(["list_findings"]);
  });

  it("marks only read-only tools as read-only", () => {
    const all = buildToolset("merge", { core: harness().core, store: harness().store });
    expect(Object.fromEntries(all.map((t: ToolSpec) => [t.name, t.readOnly]))).toEqual({
      list_findings: true, exa_run_output: true, record_finding: false, merge_findings: false, record_gap: false,
    });
  });
});

describe("argument validation", () => {
  it("returns a readable error instead of throwing", async () => {
    const { call } = setup("segment");
    const r = await call("search", { query: "" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Invalid arguments: query/);
    const bad = await call("record_finding", { claim: "short", sources: [], source_kind: "primary" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/claim.*sources/s);
  });

  it("turns engine errors into tool errors", async () => {
    const { call } = setup("segment", { engines: ["exa"], exa: { search: () => { throw new Error("exa exploded"); } } });
    const r = await call("search", { query: "q" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/exa exploded/);
  });
});

describe("record_finding", () => {
  it("refuses URLs that no search or fetch in the job returned", async () => {
    const { call, h } = setup("segment");
    const r = await call("record_finding", { claim: "OpenSSL 3.5 ships ML-KEM support", sources: ["https://invented.example/post"], source_kind: "primary" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/never returned by a search or fetch in this job.*invented\.example/s);
    expect(h.store.listFindings(h.core.jobId!)).toHaveLength(0);
  });

  it("accepts searched URLs and marks the evidence as snippet-only until a page is read", async () => {
    const { call, h } = setup("segment");
    await call("search", { query: "openssl ml-kem" });
    const r = await call("record_finding", { claim: "OpenSSL 3.5 ships ML-KEM support", sources: ["https://a.example/one"], source_kind: "primary" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toMatch(/evidence: snippet only; found by: exa\)/);
    const [f] = h.store.listFindings(h.core.jobId!);
    expect(f).toMatchObject({ segment: "seg1", evidence: "snippet", sourceKind: "primary", critical: false });
  });

  it("computes evidence from what was actually read, whatever the model says", async () => {
    const { call, h } = setup("segment");
    await call("search", { query: "q" });
    await call("fetch", { urls: ["https://a.example/one"] });
    await call("record_finding", { claim: "A claim backed by a fully read page", sources: ["https://a.example/one", "https://b.example/two"], source_kind: "secondary", critical: true, published_date: "2026-09-01" });
    expect(h.store.listFindings(h.core.jobId!)[0]).toMatchObject({ evidence: "fetched", critical: true, publishedDate: "2026-09-01", sourceKind: "secondary" });
  });

  it("accepts a URL that was only fetched (e.g. given by the user), via a different spelling", async () => {
    const { call, h } = setup("segment");
    h.core.seedUserUrls("Please check https://c.example/doc for this."); // a URL from the user's question
    await call("fetch", { urls: ["https://c.example/doc"] });
    const r = await call("record_finding", { claim: "A claim from a fetched-only page", sources: ["http://www.c.example/doc/#top"], source_kind: "primary" });
    expect(r.isError).toBeUndefined();
    expect(h.store.listFindings(h.core.jobId!)[0]!.evidence).toBe("fetched");
  });

  it("does not trust sources seen in another job", async () => {
    const { call, h } = setup("segment");
    const other = h.store.upsertSource({ url: "https://other-job.example/x" });
    h.store.addHit({ sourceId: other, jobId: "job_other", engine: "exa", rank: 1 });
    const r = await call("record_finding", { claim: "A claim citing another job's source", sources: ["https://other-job.example/x"], source_kind: "primary" });
    expect(r.isError).toBe(true);
  });
});

describe("record_gap and list_findings", () => {
  it("records gaps under the session's segment", async () => {
    const { call, h } = setup("segment");
    await call("record_gap", { description: "No vendor statements before 2025 found" });
    expect(h.store.listGaps(h.core.jobId!)).toEqual([{ segment: "seg1", description: "No vendor statements before 2025 found" }]);
  });

  it("lists findings with sources, read state, engines and pages through them", async () => {
    const { call, h } = setup("merge");
    const s = h.core.resolveSources(["https://a.example/one"])[0]!;
    h.store.addHit({ sourceId: s, jobId: h.core.jobId!, engine: "exa", rank: 1 });
    for (let i = 0; i < 65; i++) h.store.addFinding({ jobId: h.core.jobId!, segment: i % 2 ? "x" : "y", claim: `claim number ${i}`, sourceIds: [s], sourceKind: "primary", evidence: "snippet", critical: i === 0 });
    const first = await call("list_findings", {});
    expect(first.text).toMatch(/^65 finding\(s\); showing 1-60\. Next page: offset 60\./);
    expect(first.text).toContain("CRITICAL");
    expect(first.text).toContain("https://a.example/one [unread]");
    expect(first.text).toContain("engines: exa");
    const second = await call("list_findings", { offset: 60 });
    expect(second.text).toMatch(/showing 61-65\./);
    expect((await call("list_findings", { segment: "x" })).text).toMatch(/^32 finding\(s\)/);
  });
});

describe("merge_findings", () => {
  it("folds duplicates and reports it", async () => {
    const { call, h } = setup("merge");
    const j = h.core.jobId!;
    const a = h.store.addFinding({ jobId: j, segment: "s", claim: "same fact one", sourceIds: [1], sourceKind: "primary", evidence: "snippet" });
    const b = h.store.addFinding({ jobId: j, segment: "s", claim: "same fact two", sourceIds: [2], sourceKind: "primary", evidence: "snippet" });
    const r = await call("merge_findings", { keep_id: a, merge_ids: [b] });
    expect(r.text).toMatch(/Merged 1 finding\(s\)/);
    expect(h.store.listFindings(j)).toHaveLength(1);
    expect((await call("merge_findings", { keep_id: a, merge_ids: [999] })).isError).toBe(true);
  });
});

describe("set_verification guardrails", () => {
  async function withFinding(opts: { read: string[]; cited: string[]; critical?: boolean }) {
    const s = setup("verify");
    await s.call("search", { query: "q" });
    for (const u of opts.read) await s.call("fetch", { urls: [u] });
    const ids = s.h.core.resolveSources(opts.cited);
    const id = s.h.store.addFinding({ jobId: s.h.core.jobId!, segment: "s", claim: "A claim worth verifying", sourceIds: ids, sourceKind: "primary", evidence: "snippet", critical: opts.critical });
    return { ...s, id };
  }

  it("downgrades 'verified' to unverified when no cited page was read in full", async () => {
    const { call, h, id } = await withFinding({ read: [], cited: ["https://a.example/one"] });
    const r = await call("set_verification", { finding_id: id, status: "verified", note: "looks right" });
    expect(r.text).toMatch(/set to unverified instead of verified/);
    expect(h.store.getFinding(id)).toMatchObject({ verification: "unverified" });
    expect(h.store.getFinding(id)!.verificationNote).toMatch(/no cited page was read in full/);
  });

  it("accepts 'verified' when a cited page was read", async () => {
    const { call, h, id } = await withFinding({ read: ["https://a.example/one"], cited: ["https://a.example/one"] });
    const r = await call("set_verification", { finding_id: id, status: "verified", note: "page states it verbatim" });
    expect(r.text).toBe(`Finding #${id} set to verified.`);
    expect(h.store.getFinding(id)!.verification).toBe("verified");
  });

  it("requires two independent hosts for a critical finding", async () => {
    const one = await withFinding({ read: ["https://a.example/one"], cited: ["https://a.example/one", "https://a.example/other-page"], critical: true });
    await one.call("set_verification", { finding_id: one.id, status: "verified", note: "n" });
    expect(one.h.store.getFinding(one.id)!.verification).toBe("single_source");
    expect(one.h.store.getFinding(one.id)!.verificationNote).toMatch(/two independent hosts.*found 1/);

    const two = await withFinding({ read: ["https://a.example/one", "https://b.example/two"], cited: ["https://a.example/one"], critical: true });
    const r = await two.call("set_verification", { finding_id: two.id, status: "verified", note: "confirmed independently", extra_sources: ["https://b.example/two"] });
    expect(r.text).toMatch(/set to verified\./);
    expect(two.h.store.getFinding(two.id)).toMatchObject({ verification: "verified" });
    expect(two.h.store.getFinding(two.id)!.sourceIds).toHaveLength(2);
  });

  it("does not let extra sources be invented", async () => {
    const { call, id } = await withFinding({ read: ["https://a.example/one"], cited: ["https://a.example/one"] });
    const r = await call("set_verification", { finding_id: id, status: "verified", note: "n", extra_sources: ["https://made-up.example/page"] });
    expect(r.isError).toBe(true);
  });

  it("passes through the weaker statuses unchanged and rejects other jobs' findings", async () => {
    const { call, h, id } = await withFinding({ read: [], cited: ["https://a.example/one"] });
    for (const status of ["single_source", "unverified", "contradicted"] as const) {
      await call("set_verification", { finding_id: id, status, note: `because ${status}` });
      expect(h.store.getFinding(id)).toMatchObject({ verification: status, verificationNote: `because ${status}` });
    }
    const foreign = h.store.addFinding({ jobId: "job_other", segment: "s", claim: "belongs to another job", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
    expect((await call("set_verification", { finding_id: foreign, status: "verified", note: "n" })).isError).toBe(true);
  });
});

describe("exa_run_output", () => {
  it("returns the output and registers the cited pages so findings can cite them", async () => {
    const s = setup("merge");
    const j = s.h.core.jobId!;
    s.h.store.upsertExaRun({
      id: "run_x", jobId: j, planRunId: "list-crates", effort: "high", status: "completed", stopReason: "schema_satisfied", costUsd: 0.5, finished: true,
      output: { text: "Found 2 crates", structured: { crates: [{ name: "ml-kem" }] }, grounding: [{ field: "crates.0.name", citations: [{ url: "https://crates.io/crates/ml-kem" }, { url: "javascript:alert(1)" }] }] },
    });
    const r = await s.call("exa_run_output", { run_id: "list-crates" });
    expect(r.text).toMatch(/Exa run list-crates: completed \(schema_satisfied\), cost \$0\.500/);
    expect(r.text).toContain("ml-kem");
    const cite = await s.call("record_finding", { claim: "The ml-kem crate exists on crates.io", sources: ["https://crates.io/crates/ml-kem"], source_kind: "primary" });
    expect(cite.isError).toBeUndefined();
    expect(s.h.store.getSourceByUrl("javascript:alert(1)")).toBeUndefined();
    expect((await s.call("exa_run_output", { run_id: "nope" })).isError).toBe(true);
  });
});

describe("without a job", () => {
  it("findings and gaps are refused", async () => {
    const h: Harness = harness();
    const tools = buildToolset("segment", { core: h.core, store: h.store });
    const f = tools.find((t) => t.name === "record_finding")!;
    expect((await f.handler({ claim: "A claim without any job", sources: ["https://a.example/one"], source_kind: "primary" })).isError).toBe(true);
  });
});
