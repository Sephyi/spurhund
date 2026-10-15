import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Plan } from "../src/worker/plan.js";
import { buildReport } from "../src/worker/report.js";
import { buildToolset } from "../src/worker/tools.js";
import { LONG_TEXT, harness } from "./helpers.js";

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
