import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/db/store.js";

function setup() {
  let t = Date.parse("2026-10-15T10:00:00Z");
  const clock = { now: () => new Date(t), advanceDays: (d: number) => void (t += d * 86_400_000) };
  const store = Store.memory(clock.now);
  const planId = store.createPlan({ question: "q", depth: "standard", plan: { a: 1 }, worstCaseUsd: 1.5, maxExaUsd: 5 });
  return { store, clock, planId };
}

describe("plans and jobs", () => {
  it("round-trips a plan", () => {
    const { store, planId } = setup();
    const p = store.getPlan(planId)!;
    expect(p).toMatchObject({ question: "q", depth: "standard", plan: { a: 1 }, worstCaseUsd: 1.5, status: "awaiting_approval" });
    expect(store.getPlan("plan_nope")).toBeUndefined();
  });

  it("creating a job approves the plan exactly once", () => {
    const { store, planId } = setup();
    const id = store.createJob({ planId, authMode: "oauth", models: { worker: "w" }, maxExaUsd: 5 });
    expect(store.getPlan(planId)!.status).toBe("approved");
    expect(store.getJob(id)).toMatchObject({ state: "submitted", phase: "submitted", authMode: "oauth", models: { worker: "w" } });
    expect(() => store.createJob({ planId, authMode: "oauth", models: {}, maxExaUsd: 5 })).toThrow(/already started/);
    expect(() => store.createJob({ planId: "plan_x", authMode: "oauth", models: {}, maxExaUsd: 5 })).toThrow(/does not exist/);
  });

  it("claims submitted jobs oldest first and only once", () => {
    const { store } = setup();
    const mk = () => {
      const p = store.createPlan({ question: "q", depth: "standard", plan: {}, worstCaseUsd: 0, maxExaUsd: 5 });
      return store.createJob({ planId: p, authMode: "oauth", models: {}, maxExaUsd: 5 });
    };
    const a = mk();
    const b = mk();
    expect(store.claimNextSubmitted(111)!.id).toBe(a);
    expect(store.getJob(a)).toMatchObject({ state: "working", pid: 111 });
    expect(store.claimNextSubmitted(222)!.id).toBe(b);
    expect(store.claimNextSubmitted(333)).toBeUndefined();
    expect(store.claimJob(a, 9)).toBeUndefined();
  });

  it("finishJob is terminal and idempotent", () => {
    const { store, planId } = setup();
    const id = store.createJob({ planId, authMode: "api", models: {}, maxExaUsd: 5 });
    expect(store.finishJob(id, "completed")).toBe(true);
    expect(store.finishJob(id, "failed", "late error")).toBe(false);
    expect(store.getJob(id)).toMatchObject({ state: "completed", error: null });
  });

  it("cancel flag round-trips", () => {
    const { store, planId } = setup();
    const id = store.createJob({ planId, authMode: "api", models: {}, maxExaUsd: 5 });
    expect(store.isCancelRequested(id)).toBe(false);
    store.requestCancel(id);
    expect(store.isCancelRequested(id)).toBe(true);
  });

  it("reaps working jobs whose worker died, honouring a pending cancel", () => {
    const { store } = setup();
    const mk = () =>
      store.createJob({
        planId: store.createPlan({ question: "q", depth: "standard", plan: {}, worstCaseUsd: 0, maxExaUsd: 5 }),
        authMode: "oauth",
        models: {},
        maxExaUsd: 5,
      });
    const crashed = mk();
    const canceled = mk();
    const alive = mk();
    store.claimJob(crashed, 1);
    store.claimJob(canceled, 2);
    store.claimJob(alive, 3);
    store.requestCancel(canceled);
    const reaped = store.reapDeadJobs((pid) => pid === 3);
    expect(reaped.sort()).toEqual([crashed, canceled].sort());
    expect(store.getJob(crashed)).toMatchObject({ state: "failed" });
    expect(store.getJob(crashed)!.error).toMatch(/gone/);
    expect(store.getJob(canceled)!.state).toBe("canceled");
    expect(store.getJob(alive)!.state).toBe("working");
  });

  it("lists newest jobs first", () => {
    const { store, planId, clock } = setup();
    const first = store.createJob({ planId, authMode: "oauth", models: {}, maxExaUsd: 5 });
    clock.advanceDays(1);
    const p2 = store.createPlan({ question: "q2", depth: "deep", plan: {}, worstCaseUsd: 0, maxExaUsd: 5 });
    const second = store.createJob({ planId: p2, authMode: "oauth", models: {}, maxExaUsd: 5 });
    expect(store.listJobs().map((j) => j.id)).toEqual([second, first]);
    expect(store.listJobs(1)).toHaveLength(1);
  });
});

describe("events and calls", () => {
  it("returns the latest events in chronological order", () => {
    const { store } = setup();
    for (let i = 1; i <= 5; i++) store.addEvent("job_1", "execute", `step ${i}`);
    expect(store.listEvents("job_1", 3).map((e) => e.message)).toEqual(["step 3", "step 4", "step 5"]);
  });

  it("sums cost per job and engine", () => {
    const { store } = setup();
    store.recordCall({ jobId: "j", engine: "exa", endpoint: "search", query: "q", ok: true, latencyMs: 10, costUsd: 0.007 });
    store.recordCall({ jobId: "j", engine: "exa", endpoint: "agent", query: "q", ok: true, latencyMs: 10, costUsd: 0.5 });
    store.recordCall({ jobId: "j", engine: "brave", endpoint: "llm/context", query: "q", ok: true, latencyMs: 10, costUsd: 0.005 });
    store.recordCall({ jobId: null, engine: "exa", endpoint: "search", query: "adhoc", ok: false, error: "x", latencyMs: 1, costUsd: 0 });
    expect(store.sumCost("j", "exa")).toBeCloseTo(0.507);
    expect(store.jobStats("j")).toMatchObject({ engineCalls: 3, braveCostUsd: 0.005 });
  });
});

describe("sources and the fetch cache", () => {
  it("dedupes by canonical URL and keeps the first title and date", () => {
    const { store } = setup();
    const a = store.upsertSource({ url: "https://www.e.com/p?utm_source=x", title: "First", publishedDate: null });
    const b = store.upsertSource({ url: "http://e.com/p/#frag", title: "Second", publishedDate: "2026-01-01" });
    expect(b).toBe(a);
    expect(store.getSource(a)).toMatchObject({ title: "First", publishedDate: "2026-01-01" });
  });

  it("reuses a complete page within the TTL", () => {
    const { store, clock } = setup();
    const id = store.upsertSource({ url: "https://e.com/doc" });
    store.saveFetch(id, { readStatus: "read", text: "full text", maxChars: 3000 });
    expect(store.getCachedFetch("https://e.com/doc", 7, 20_000)?.text).toBe("full text");
    clock.advanceDays(8);
    expect(store.getCachedFetch("https://e.com/doc", 7, 3000)).toBeUndefined();
  });

  it("reuses a truncated page only when it was fetched with enough characters", () => {
    const { store } = setup();
    const id = store.upsertSource({ url: "https://e.com/long" });
    store.saveFetch(id, { readStatus: "truncated", text: "x".repeat(3000), maxChars: 3000 });
    expect(store.getCachedFetch("https://e.com/long", 7, 3000)).toBeDefined();
    expect(store.getCachedFetch("https://e.com/long", 7, 12_000)).toBeUndefined();
  });

  it("never reuses unread pages and honours a zero TTL", () => {
    const { store } = setup();
    const id = store.upsertSource({ url: "https://e.com/wall" });
    store.saveFetch(id, { readStatus: "not_read", text: null, maxChars: 3000 });
    expect(store.getCachedFetch("https://e.com/wall", 7, 3000)).toBeUndefined();
    const ok = store.upsertSource({ url: "https://e.com/ok" });
    store.saveFetch(ok, { readStatus: "read", text: "t", maxChars: 3000 });
    expect(store.getCachedFetch("https://e.com/ok", 0, 3000)).toBeUndefined();
  });

  it("tracks which engines found a source in a job", () => {
    const { store } = setup();
    const s = store.upsertSource({ url: "https://e.com/x" });
    store.addHit({ sourceId: s, jobId: "j", engine: "exa", rank: 1 });
    store.addHit({ sourceId: s, jobId: "j", engine: "exa", rank: 2 });
    store.addHit({ sourceId: s, jobId: "j", engine: "brave", rank: 4 });
    store.addHit({ sourceId: s, jobId: "other", engine: "brave", rank: 1 });
    expect(store.enginesBySource("j").get(s)!.sort()).toEqual(["brave", "exa"]);
    expect(store.jobStats("j").sources).toBe(1);
  });
});

describe("findings, gaps, exa runs, reports", () => {
  const base = { jobId: "j", segment: "s1", sourceKind: "primary", evidence: "fetched" } as const;

  it("stores findings with de-duplicated source ids", () => {
    const { store } = setup();
    const id = store.addFinding({ ...base, claim: "c", sourceIds: [1, 2, 2], critical: true });
    expect(store.getFinding(id)).toMatchObject({ sourceIds: [1, 2], critical: true, verification: "unchecked", engine: null });
    store.setVerification(id, "verified", "two sources");
    expect(store.getFinding(id)).toMatchObject({ verification: "verified", verificationNote: "two sources" });
  });

  it("merges findings by unioning sources and criticality", () => {
    const { store } = setup();
    const a = store.addFinding({ ...base, claim: "same fact", sourceIds: [1] });
    const b = store.addFinding({ ...base, claim: "same fact, reworded", sourceIds: [2, 3], critical: true });
    store.mergeFindings(a, [b, a]);
    expect(store.listFindings("j")).toHaveLength(1);
    expect(store.getFinding(a)).toMatchObject({ sourceIds: [1, 2, 3], critical: true });
  });

  it("refuses to merge findings across jobs", () => {
    const { store } = setup();
    const a = store.addFinding({ ...base, claim: "a", sourceIds: [1] });
    const b = store.addFinding({ ...base, jobId: "k", claim: "b", sourceIds: [1] });
    expect(() => store.mergeFindings(a, [b])).toThrow(/same job/);
    expect(store.getFinding(b)).toBeDefined();
  });

  it("stores gaps", () => {
    const { store } = setup();
    store.addGap("j", "s1", "no sources before 2024");
    expect(store.listGaps("j")).toEqual([{ segment: "s1", description: "no sources before 2024" }]);
  });

  it("upserts exa runs and keeps the output", () => {
    const { store } = setup();
    store.upsertExaRun({ id: "run_1", jobId: "j", planRunId: "r1", effort: "high", status: "running" });
    store.upsertExaRun({
      id: "run_1",
      jobId: "j",
      planRunId: "r1",
      effort: "high",
      status: "completed",
      stopReason: "schema_satisfied",
      costUsd: 0.5,
      output: { text: "done" },
      finished: true,
    });
    expect(store.listExaRuns("j")).toHaveLength(1);
    expect(store.getExaRun("run_1")).toMatchObject({ status: "completed", costUsd: 0.5, output: { text: "done" } });
    expect(store.getExaRun("run_1")!.finishedAt).not.toBeNull();
  });

  it("stores and replaces a report", () => {
    const { store } = setup();
    store.saveReport("j", "# one", { v: 1 });
    store.saveReport("j", "# two", { v: 2 });
    expect(store.getReport("j")).toEqual({ markdown: "# two", json: { v: 2 } });
    expect(store.getReport("nope")).toBeUndefined();
    expect(store.listReportJobIds()).toEqual(["j"]);
  });
});

describe("file-backed database", () => {
  it("creates directories, persists data and reopens the same schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-store-"));
    try {
      const file = path.join(dir, "nested", "spurhund.db");
      const a = Store.open(file);
      const plan = a.createPlan({ question: "persist", depth: "deep", plan: {}, worstCaseUsd: 1, maxExaUsd: 5 });
      a.close();
      const b = Store.open(file);
      expect(b.getPlan(plan)?.question).toBe("persist");
      b.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the database private to the user", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-perm-"));
    try {
      const file = path.join(dir, "home", "spurhund.db");
      const a = Store.open(file);
      a.createPlan({ question: "x", depth: "standard", plan: {}, worstCaseUsd: 0, maxExaUsd: 5 });
      if (process.platform !== "win32") {
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
        for (const ext of ["-wal", "-shm"]) {
          if (fs.existsSync(file + ext)) expect(fs.statSync(file + ext).mode & 0o077, ext).toBe(0);
        }
      }
      a.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two connections see each other's writes (WAL)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-wal-"));
    try {
      const file = path.join(dir, "s.db");
      const a = Store.open(file);
      const b = Store.open(file);
      const plan = a.createPlan({ question: "x", depth: "standard", plan: {}, worstCaseUsd: 0, maxExaUsd: 5 });
      const job = a.createJob({ planId: plan, authMode: "oauth", models: {}, maxExaUsd: 5 });
      expect(b.claimNextSubmitted(42)?.id).toBe(job);
      expect(a.getJob(job)?.state).toBe("working");
      a.close();
      b.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
