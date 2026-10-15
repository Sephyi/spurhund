import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { computeWorstCase, type Plan } from "../src/worker/plan.js";
import { buildReport } from "../src/worker/report.js";
import { buildToolset } from "../src/worker/tools.js";
import { NarrativeSchema, mergePrompt, plannerPrompt, plannerSystem, reportPrompt, segmentPrompt } from "../src/worker/prompts.js";
import { LONG_TEXT, harness } from "./helpers.js";
import { summarize } from "../src/jobs.js";
import { formatSearch } from "../src/mcp/format.js";
import { EngineError, Limiter, withRetry } from "../src/util.js";
import { canonicalUrl } from "../src/canonical.js";
import { PRICES, estimateSegmentExaSpend } from "../src/costs.js";

const plan: Plan = {
  question: "Which releases support the protocol?",
  successCriteria: "Release status backed by primary sources",
  timeWindow: { from: null, to: null },
  languages: ["en"],
  segments: [{ id: "releases", name: "Releases", objective: "Find releases", angles: ["official sources"], languages: ["en"], engines: ["exa"], seedQueries: ["official protocol releases"] }],
  exaRuns: [],
  notes: null,
};

function evidenceSetup() {
  const h = harness({ job: { cap: 5 }, engines: ["exa"], exa: {
    search: () => ({ results: [{ url: "https://docs.example.com/releases", highlights: ["Release notes"] }] }),
    getContents: (urls) => ({ results: urls.map((url) => ({ url, text: LONG_TEXT })) }),
  } });
  const jobId = h.core.jobId!;
  const ctx = { core: h.core, store: h.store, jobId, segment: "releases" };
  const call = (role: "segment" | "verify", name: string, args: Record<string, unknown>) => buildToolset(role, ctx).find((t) => t.name === name)!.handler(args);
  const report = () => buildReport(h.store, {
    job: { ...h.store.getJob(jobId)!, state: "completed" },
    planRow: { ...h.store.getPlan(h.store.getJob(jobId)!.planId)!, plan },
    config: loadConfig({}),
  });
  return { ...h, jobId, call, report };
}

describe("evidence refresh", () => {
  it("reports a snippet finding as page read after the verifier fetches it", async () => {
    const h = evidenceSetup();
    try {
      await h.call("segment", "search", { query: "official releases" });
      await h.call("segment", "record_finding", { claim: "The official release supports the protocol", sources: ["https://docs.example.com/releases"], source_kind: "primary" });
      const f = h.store.listFindings(h.jobId)[0]!;
      expect(f.evidence).toBe("snippet");
      await h.call("verify", "fetch", { urls: ["https://docs.example.com/releases"] });
      await h.call("verify", "set_verification", { finding_id: f.id, status: "verified", note: "Release notes state it" });
      const report = h.report();
      expect(report.markdown).toContain("page read");
      expect(report.json.findings.filter((x) => x.verification === "verified" && x.evidence === "snippet")).toEqual([]);
    } finally { h.store.close(); }
  });

  it("refreshes evidence after sources change or findings merge, without borrowing another job's read", () => {
    const h = evidenceSetup();
    try {
      const sourceId = h.store.upsertSource({ url: "https://docs.example.com/releases" });
      h.store.saveFetch(sourceId, { readStatus: "truncated", text: LONG_TEXT, maxChars: 1000 });
      const a = h.store.addFinding({ jobId: h.jobId, segment: "releases", claim: "A snippet claim", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
      h.store.setSourceIds(a, [sourceId]);
      expect(h.store.getFinding(a)!.evidence).toBe("snippet");
      h.store.addHit({ sourceId, jobId: h.jobId, engine: "fetch", rank: 0 });
      h.store.setSourceIds(a, [sourceId]);
      expect(h.store.getFinding(a)!.evidence).toBe("fetched");
      const b = h.store.addFinding({ jobId: h.jobId, segment: "releases", claim: "A duplicate claim", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
      h.store.mergeFindings(b, [a], h.jobId);
      expect(h.store.getFinding(b)!.evidence).toBe("fetched");
      h.store.setSourceIds(b, []);
      expect(h.store.getFinding(b)!.evidence).toBe("snippet");
    } finally { h.store.close(); }
  });
});

it("keeps coverage explicitly separate from later verification", () => {
  const h = evidenceSetup();
  try {
    expect(mergePrompt({ plan, exaRunIds: [] })).toContain("Verification runs after you. Do not comment on verification status; judge coverage only by what was found and from where.");
    expect(h.report().markdown).toContain("Coverage (assessed at merge, before verification)");
  } finally { h.store.close(); }
});

describe("resolved gaps", () => {
  it("closes only this job's gaps using verified findings and splits the report", async () => {
    const h = evidenceSetup();
    try {
      const f = h.store.addFinding({ jobId: h.jobId, segment: "releases", claim: "Release status is documented", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
      h.store.addGap(h.jobId, "releases", "Release date not found");
      h.store.addGap(h.jobId, "releases", "Older history not found");
      h.store.addGap("other-job", "other", "Another job's gap");
      const gap = h.store.listGaps(h.jobId)[0]!;
      const other = h.store.listGaps("other-job")[0]!;
      const tool = buildToolset("verify", { core: h.core, store: h.store, jobId: h.jobId }).find((t) => t.name === "resolve_gap");
      expect(tool).toBeDefined();
      expect((await tool!.handler({ gap_id: gap.id, finding_ids: [f], note: "Answered" })).isError).toBe(true);
      h.store.setVerification(f, "verified", "Checked");
      expect(() => h.store.resolveGap(h.jobId, other.id, [f], "Wrong job")).toThrow(/not found.*job/i);
      expect((await tool!.handler({ gap_id: gap.id, finding_ids: [f], note: "Release states the date" })).isError).toBeUndefined();
      const r = h.report();
      expect(r.json.gaps.map((g) => g.description)).toEqual(["Older history not found"]);
      expect(r.json.closedGaps[0]).toMatchObject({ id: gap.id, resolvedBy: [f], resolvedNote: "Release states the date" });
      expect(r.markdown).toContain("## Open gaps");
      expect(r.markdown).toContain("## Closed gaps");
      expect(r.markdown).toContain(`[#${f}]`);
      expect(summarize(r.json)).not.toContain("Release date not found");
      expect(h.store.jobStats(h.jobId).gaps).toBe(1);
      for (const role of ["planner", "segment", "merge", "gap", "report"] as const) expect(buildToolset(role, { core: h.core, store: h.store, jobId: h.jobId }).map((t) => t.name)).not.toContain("resolve_gap");
    } finally { h.store.close(); }
  });
});

it("asks for one short prose summary without duplicate takeaways", () => {
  expect(NarrativeSchema.safeParse({ summary: "A sourced answer [#4]." }).success).toBe(true);
  expect(Object.keys(NarrativeSchema.shape)).toEqual(["summary"]);
  const prompt = reportPrompt({ plan, state: "completed" });
  expect(prompt).toContain("at most 250 words");
  expect(prompt).toContain("no bullet list");
  expect(prompt).toContain("[#4]");
  const h = evidenceSetup();
  try { expect(h.report().json).not.toHaveProperty("keyTakeaways"); }
  finally { h.store.close(); }
});

it("separates answer requirements from unverified calibration leads", () => {
  expect(plannerSystem()).toContain("Never a candidate answer, number or date");
  expect(plannerSystem()).toContain("Unverified lead:");
  const prompt = segmentPrompt({ plan: { ...plan, notes: "Unverified lead: release candidate" }, segmentId: "releases", depth: "standard" });
  expect(prompt).toContain("Plan notes are unverified leads; confirm or refute them from sources, do not assume them.");
  expect(prompt).toContain("Unverified lead: release candidate");
});

it("defaults the Claude job cap to three dollars and rejects invalid caps", () => {
  expect(loadConfig({}).claudeMaxUsdPerJob).toBe(3);
  for (const value of ["0", "-1", "NaN", "Infinity"]) expect(() => loadConfig({ SPURHUND_MAX_CLAUDE_USD_PER_JOB: value })).toThrow(/SPURHUND_MAX_CLAUDE_USD_PER_JOB/);
});

describe("compact worker output", () => {
  it("returns only ten short leads to workers while preserving all user-facing results", async () => {
    const h = harness({ engines: ["exa"], exa: { search: () => ({ results: Array.from({ length: 25 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Result ${i}`, publishedDate: "2026-10-01", highlights: ["a".repeat(1000), "b".repeat(1000)] })) }) } });
    try {
      const out = await h.core.search({ query: "q", numResults: 25 });
      const compact = formatSearch(out, { compact: true });
      expect(compact.length).toBeLessThan(5000);
      expect(compact.match(/^\d+\. /gm)).toHaveLength(10);
      expect(compact).toContain("2026-10-01");
      expect(compact).toContain("exa");
      expect(compact).not.toContain("a".repeat(301));
      expect(compact).not.toContain("b".repeat(10));
      expect(formatSearch(out).match(/^\d+\. /gm)).toHaveLength(25);
      expect(out.results).toHaveLength(25);
    } finally { h.store.close(); }
  });

  it("defaults worker fetches to 6000 characters and rejects more than three URLs", async () => {
    const h = evidenceSetup();
    try {
      const urls = Array.from({ length: 4 }, (_, i) => `https://example.com/${i}`);
      h.core.seedUserUrls(urls.join(" "));
      const result = await h.call("segment", "fetch", { urls });
      expect(result.isError).toBe(true);
      await h.call("segment", "fetch", { urls: urls.slice(0, 3) });
      expect(h.exaClient.getContents.mock.calls[0]![1]).toEqual({ text: { maxCharacters: 6000 } });
    } finally { h.store.close(); }
  });

  it("keeps each finding to one line plus sources, including its verification note", async () => {
    const h = evidenceSetup();
    try {
      const id = h.store.addFinding({ jobId: h.jobId, segment: "releases", claim: "A claim\nwith extra lines", sourceIds: [], sourceKind: "primary", evidence: "snippet" });
      h.store.setVerification(id, "unverified", "A note\nwith extra lines");
      const tool = buildToolset("report", { core: h.core, store: h.store, jobId: h.jobId })[0]!;
      expect((await tool.handler({})).text.split("\n")).toHaveLength(3);
    } finally { h.store.close(); }
  });
});

it("requests claim highlights without text, marks them truncated, then really fetches full text", async () => {
  const h = harness({ job: { cap: 5 }, engines: ["exa"], exa: { getContents: (urls, options) => ({ results: urls.map((url) => ({ url, ...(options.highlights ? { highlights: ["The release supports TLS."] } : { text: LONG_TEXT }) })) }) } });
  const jobId = h.core.jobId!;
  const url = "https://example.com/releases";
  h.core.seedUserUrls(url);
  const sourceId = h.store.getSourceByUrl(url)!.id;
  h.store.saveFetch(sourceId, { readStatus: "read", text: LONG_TEXT, maxChars: 6000 });
  const id = h.store.addFinding({ jobId, segment: "s", claim: "The release supports TLS", sourceIds: [sourceId], sourceKind: "primary", evidence: "snippet" });
  const tools = buildToolset("verify", { core: h.core, store: h.store, jobId });
  const fetch = tools.find((t) => t.name === "fetch")!;
  try {
    const highlights = await fetch.handler({ urls: [url], claim: "Does this release support TLS?" });
    expect(h.exaClient.getContents).toHaveBeenCalledTimes(1);
    expect(h.exaClient.getContents.mock.calls[0]![1]).toEqual({ highlights: { query: "Does this release support TLS?", maxCharacters: 6000 } });
    expect(highlights.text).toContain("TRUNCATED");
    expect(h.store.getSource(sourceId)!.readStatus).toBe("truncated");
    const checked = await tools.find((t) => t.name === "set_verification")!.handler({ finding_id: id, status: "verified", note: "Only highlights" });
    expect(checked.text).toContain("unverified");
    expect(h.store.getFinding(id)!.evidence).toBe("fetched");
    await fetch.handler({ urls: [url] });
    expect(h.exaClient.getContents).toHaveBeenCalledTimes(2);
    expect(h.store.getSource(sourceId)!.readStatus).toBe("read");
    const segmentFetch = buildToolset("segment", { core: h.core, store: h.store, jobId }).find((t) => t.name === "fetch")!;
    expect(segmentFetch.shape).not.toHaveProperty("claim");
  } finally { h.store.close(); }
});

describe("in-job search cache", () => {
  it.each([false, true])("charges identical searches once, concurrent=%s", async (concurrent) => {
    const h = harness({ job: { cap: 5 }, engines: ["exa"], exa: { search: () => ({ results: [{ url: "https://example.com/", highlights: ["lead"] }], costDollars: { total: 0.01 } }) } });
    try {
      const search = () => h.core.search({ query: "official protocol releases", objective: "release dates", numResults: 10 });
      const [first, second] = concurrent ? await Promise.all([search(), search()]) : [await search(), await search()];
      expect(h.exaClient.search).toHaveBeenCalledTimes(1);
      expect(second.results).toEqual(first.results);
      expect(first.costUsd + second.costUsd).toBeCloseTo(0.01);
      expect(h.store.jobStats(h.core.jobId!).engineCalls).toBe(1);
      expect(h.store.sumCost(h.core.jobId!, "exa")).toBeCloseTo(0.01);
      await h.core.search({ query: "official protocol releases", objective: "different goal" });
      expect(h.exaClient.search).toHaveBeenCalledTimes(2);
    } finally { h.store.close(); }
  });

  it("does not cache ad-hoc searches", async () => {
    const h = harness({ engines: ["exa"] });
    try {
      await h.core.search({ query: "q" });
      await h.core.search({ query: "q" });
      expect(h.exaClient.search).toHaveBeenCalledTimes(2);
    } finally { h.store.close(); }
  });
});

it("hands slots directly to waiters despite late microtask arrivals", async () => {
  const limiter = new Limiter(2);
  let active = 0;
  let max = 0;
  const releases: (() => void)[] = [];
  const late: Promise<void>[] = [];
  const task = async () => {
    max = Math.max(max, ++active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
  };
  const held = () => {
    max = Math.max(max, ++active);
    const p = new Promise<void>((resolve) => releases.push(resolve));
    void p.then(() => {
      active--;
      queueMicrotask(() => { late.push(limiter.run(task)); });
    });
    return p;
  };
  const initial = [limiter.run(held), limiter.run(held), ...Array.from({ length: 6 }, () => limiter.run(task))];
  releases.forEach((release) => release());
  await Promise.all(initial);
  await Promise.all(late);
  expect(initial.length + late.length).toBe(10);
  expect(max).toBe(2);
});

it.each([30_001, 3_600_000])("refuses Retry-After %i ms without holding a limiter slot", async (ms) => {
  const waits: number[] = [];
  let calls = 0;
  const error = new EngineError("rate limited", 429, ms);
  await expect(withRetry(async () => { calls++; throw error; }, { sleepFn: async (n) => { waits.push(n); } })).rejects.toBe(error);
  expect(waits).toEqual([]);
  expect(calls).toBe(1);
});

it("preserves version-selecting ref but still strips ref_src", () => {
  expect(canonicalUrl("https://api.github.com/repos/a/b/contents/x?ref=v2&ref_src=tracking")).toBe("https://api.github.com/repos/a/b/contents/x?ref=v2");
});

it("fills empty source titles and dates without overwriting real metadata", () => {
  const h = evidenceSetup();
  try {
    const id = h.store.upsertSource({ url: "https://example.com/", title: "", publishedDate: "" });
    h.store.upsertSource({ url: "https://example.com/", title: "Release notes", publishedDate: "2026-10-01" });
    expect(h.store.getSource(id)).toMatchObject({ title: "Release notes", publishedDate: "2026-10-01" });
    h.store.upsertSource({ url: "https://example.com/", title: "Different", publishedDate: "2026-10-02" });
    expect(h.store.getSource(id)).toMatchObject({ title: "Release notes", publishedDate: "2026-10-01" });
  } finally { h.store.close(); }
});

it("computes Brave spend from the central price rather than a duplicate literal", () => {
  const original = PRICES.braveRequest;
  try {
    Object.defineProperty(PRICES, "braveRequest", { value: 0.123 });
    const wc = computeWorstCase({ ...plan, segments: plan.segments.map((s) => ({ ...s, engines: ["brave"] })) }, "standard");
    expect(wc.braveUsd).toBeCloseTo(wc.braveRequests * PRICES.braveRequest);
  } finally { Object.defineProperty(PRICES, "braveRequest", { value: original }); }
});

it.each(["standard", "deep", "exhaustive"] as const)("planner gets the calculated %s allowance, not a separate price", (depth) => {
  const prompt = plannerPrompt({ question: plan.question, depth, today: "2026-10-15", extraLanguages: [], maxExaUsd: 5, allowUltra: false, engines: ["exa"], exaAvailable: true });
  expect(prompt).toContain(`$${estimateSegmentExaSpend(depth).toFixed(3)} per segment`);
  expect(plannerSystem()).toContain("Do not state a dollar total");
});
