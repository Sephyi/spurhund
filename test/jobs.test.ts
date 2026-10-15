import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, ConfigError, type Config } from "../src/config.js";
import { Store } from "../src/db/store.js";
import { FULL_RESULT_LIMIT, JobController, formatStatus, spawnWorkerProcess, summarize } from "../src/jobs.js";
import { createLogger } from "../src/log.js";
import type { Plan } from "../src/worker/plan.js";
import type { ReportJson } from "../src/worker/report.js";

const plan: Plan = {
  question: "Which Rust crates implement ML-KEM?",
  successCriteria: "list",
  timeWindow: { from: null, to: null },
  languages: ["en"],
  segments: [],
  exaRuns: [],
  notes: null,
};

function setup(env: Record<string, string> = {}, alive: (pid: number) => boolean = () => true) {
  const store = Store.memory();
  const config = loadConfig({ SPURHUND_HOME: "/tmp/spurhund-jobs-test", CLAUDE_CODE_OAUTH_TOKEN: "t", ...env });
  const spawnWorker = vi.fn<(id: string) => void>();
  const jobs = new JobController({ config, store, log: createLogger("error", { sink: () => {} }), spawnWorker, isAlive: alive });
  const newPlan = (over: { maxExaUsd?: number; worstCaseUsd?: number } = {}) =>
    store.createPlan({ question: plan.question, depth: "standard", plan, worstCaseUsd: over.worstCaseUsd ?? 1, maxExaUsd: over.maxExaUsd ?? 5 });
  return { store, config, jobs, spawnWorker, newPlan };
}

describe("JobController.start", () => {
  it("creates a job from an approved plan and spawns a worker", () => {
    const { jobs, store, spawnWorker, newPlan } = setup();
    const planId = newPlan();
    const r = jobs.start(planId);
    expect(r).toMatchObject({ queued: false, capUsd: 5 });
    expect(r.jobId).toMatch(/^job_[0-9a-f]{12}$/);
    expect(spawnWorker).toHaveBeenCalledWith(r.jobId);
    expect(store.getJob(r.jobId)).toMatchObject({ state: "submitted", authMode: "oauth", maxExaUsd: 5, models: { orchestrator: "claude-opus-5-5", worker: "claude-sonnet-5-5", verifier: "claude-sonnet-5-5" } });
  });

  it("starts each plan only once and rejects unknown plans", () => {
    const { jobs, newPlan } = setup();
    const planId = newPlan();
    jobs.start(planId);
    expect(() => jobs.start(planId)).toThrow(/already started/);
    expect(() => jobs.start("plan_nope")).toThrow(/Unknown plan/);
  });

  it("lets the cap be lowered but not raised, and warns when it is below the worst case", () => {
    const { jobs, newPlan } = setup();
    expect(() => jobs.start(newPlan({ maxExaUsd: 2 }), { maxExaUsd: 3 })).toThrow(/cannot exceed the \$2\.00 cap/);
    const r = jobs.start(newPlan({ maxExaUsd: 5, worstCaseUsd: 2 }), { maxExaUsd: 0.5 });
    expect(r.capUsd).toBe(0.5);
    expect(r.note).toMatch(/below the plan's worst case \(\$2\.00\).*partial/);
  });

  it("checks Claude credentials before creating anything", () => {
    const { jobs, store, newPlan, spawnWorker } = setup({ CLAUDE_CODE_OAUTH_TOKEN: "" });
    const planId = newPlan();
    expect(() => jobs.start(planId)).toThrow(ConfigError);
    expect(store.listJobs()).toEqual([]);
    expect(store.getPlan(planId)!.status).toBe("awaiting_approval");
    expect(spawnWorker).not.toHaveBeenCalled();
  });

  it("queues jobs beyond the concurrency limit instead of spawning more workers", () => {
    const { jobs, store, spawnWorker, newPlan } = setup({ SPURHUND_MAX_CONCURRENT_JOBS: "1" });
    const first = jobs.start(newPlan());
    store.claimJob(first.jobId, 4242);
    const second = jobs.start(newPlan());
    expect(second.queued).toBe(true);
    expect(second.note).toMatch(/1 job\(s\) are already running or starting \(limit 1\)/);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(jobs.status(second.jobId)!.queuePosition).toBe(1);
  });

  it("marks the job failed when the worker cannot be spawned", () => {
    const { jobs, store, spawnWorker, newPlan } = setup();
    spawnWorker.mockImplementation(() => {
      throw new Error("EACCES");
    });
    expect(() => jobs.start(newPlan())).toThrow(/Could not start the worker process: EACCES/);
    expect(store.listJobs()[0]).toMatchObject({ state: "failed" });
  });
});

describe("JobController.status", () => {
  it("reports state, counts and recent events, and fails dead workers", () => {
    let alive = true;
    const { jobs, store, newPlan } = setup({}, () => alive);
    const { jobId } = jobs.start(newPlan());
    store.claimJob(jobId, 999);
    store.addEvent(jobId, "execute", "Researching 2 segments");
    const s = jobs.status(jobId)!;
    expect(s.job.state).toBe("working");
    expect(s.recentEvents.map((e) => e.message)).toEqual(["Researching 2 segments"]);
    expect(formatStatus(s)).toMatch(/Job job_\w+: working \(starting\)/);
    alive = false;
    const dead = jobs.status(jobId)!;
    expect(dead.job.state).toBe("failed");
    expect(dead.job.error).toMatch(/Worker process 999 is gone/);
    expect(jobs.status("job_missing")).toBeUndefined();
  });

  it("formats elapsed time and spend", () => {
    const { jobs, store, newPlan } = setup();
    const { jobId } = jobs.start(newPlan());
    store.claimJob(jobId, process.pid);
    store.recordCall({ jobId, engine: "exa", endpoint: "search", query: "q", ok: true, latencyMs: 1, costUsd: 0.25 });
    store.addClaudeCost(jobId, 1.5);
    const text = formatStatus(jobs.status(jobId)!);
    expect(text).toMatch(/Spend: Exa \$0\.250 of \$5\.00, Brave \$0\.000, Claude ~\$1\.50 \(oauth\)/);
  });
});

describe("JobController.cancel", () => {
  it("cancels a queued job directly", () => {
    const { jobs, store, newPlan } = setup({ SPURHUND_MAX_CONCURRENT_JOBS: "1" });
    const a = jobs.start(newPlan());
    store.claimJob(a.jobId, 1);
    const b = jobs.start(newPlan());
    const r = jobs.cancel(b.jobId);
    expect(r).toMatchObject({ state: "canceled" });
    expect(store.getJob(b.jobId)!.state).toBe("canceled");
  });

  it("asks a live worker to stop", () => {
    const { jobs, store, newPlan } = setup();
    const { jobId } = jobs.start(newPlan());
    store.claimJob(jobId, process.pid);
    const r = jobs.cancel(jobId);
    expect(r.state).toBe("working");
    expect(r.message).toMatch(/Cancel requested/);
    expect(store.isCancelRequested(jobId)).toBe(true);
  });

  it("finishes the cancel itself when the worker is already gone", () => {
    let alive = true;
    const { jobs, store, newPlan } = setup({}, () => alive);
    const { jobId } = jobs.start(newPlan());
    store.claimJob(jobId, 777);
    alive = false;
    expect(jobs.cancel(jobId)).toMatchObject({ state: "canceled" });
    expect(store.getJob(jobId)!.state).toBe("canceled");
  });

  it("is idempotent for finished jobs and rejects unknown ones", () => {
    const { jobs, store, newPlan } = setup();
    const { jobId } = jobs.start(newPlan());
    store.finishJob(jobId, "completed");
    expect(jobs.cancel(jobId).message).toBe(`Job ${jobId} already completed.`);
    expect(() => jobs.cancel("job_missing")).toThrow(/Unknown job/);
  });
});

describe("JobController.result", () => {
  const reportJson = (over: Partial<ReportJson> = {}): ReportJson => ({
    jobId: "job_000000000001", state: "completed", question: plan.question, depth: "deep", partial: false, partialReason: null,
    summary: "OpenSSL and rustls ship ML-KEM (#1, #2).", keyTakeaways: ["OpenSSL 3.5 has it (#1)"],
    findings: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, segment: "s", claim: `claim ${i + 1}`, verification: i === 0 ? ("contradicted" as const) : i === 1 ? ("verified" as const) : ("single_source" as const),
      verificationNote: null, sourceKind: "primary", evidence: "fetched", critical: i === 5, engines: ["exa"], publishedDate: null,
      sources: [{ url: `https://e.com/${i + 1}`, title: null, readStatus: "read" }],
    })),
    counts: { total: 12, verified: 1, single_source: 10, unchecked: 0, unverified: 0, contradicted: 1 },
    coverage: [], gaps: [{ segment: "s", description: "2024 history is open" }], closedGaps: [],
    engines: { sourcesTotal: 12, foundBy: { exa: 12 }, singleEngineCited: {} }, exaRuns: [],
    costs: { exaUsd: 1.234, exaByEndpoint: {}, braveUsd: 0.1, claudeEstimateUsd: 2.5 },
    settings: { authMode: "oauth", models: {}, efforts: { orchestrator: "high", worker: "medium", verifier: "high" }, capUsd: 5 },
    startedAt: null, finishedAt: null, ...over,
  });

  it("summarises: answer, counts, the most important findings first, gaps, costs and resource links", () => {
    const text = summarize(reportJson());
    expect(text).toContain("OpenSSL and rustls ship ML-KEM (#1, #2).");
    expect(text).toContain("Findings: 12 (1 verified, 10 single source, 0 unverified, 1 contradicted).");
    const lines = text.split("\n").filter((l) => l.startsWith("- #"));
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain("#6 [single source, critical]"); // critical first
    expect(lines[1]).toContain("#2 [verified]");
    expect(text).toContain("… 2 more in the full report.");
    expect(text).toContain("- 2024 history is open");
    expect(text).toContain("Cost: Exa $1.23, Brave $0.10, Claude ~$2.50 (oauth)");
    expect(text).toContain("spurhund://reports/job_000000000001.md");
  });

  it("labels partial results prominently", () => {
    expect(summarize(reportJson({ partial: true, partialReason: "the job was canceled", state: "canceled" }))).toContain("PARTIAL: the job was canceled.");
  });

  it("returns the stored report, truncating very long markdown with a resource pointer", () => {
    const { jobs, store, newPlan } = setup();
    const { jobId } = jobs.start(newPlan());
    expect(jobs.result(jobId, "summary")).toMatchObject({ found: false });
    expect(jobs.result(jobId, "summary").text).toMatch(/is submitted .*report appears when it finishes/);
    store.finishJob(jobId, "failed", "boom");
    expect(jobs.result(jobId, "summary").text).toMatch(/failed \(boom\) and has no report/);

    store.saveReport(jobId, "x".repeat(FULL_RESULT_LIMIT + 500), reportJson({ jobId }));
    const full = jobs.result(jobId, "full");
    expect(full.found).toBe(true);
    expect(full.text).toContain("truncated 500 characters");
    expect(full.text).toContain(`resource spurhund://reports/${jobId}.md`);
    expect(jobs.result(jobId, "summary").text).toContain("# Which Rust crates implement ML-KEM?");
    expect(() => jobs.result("job_missing", "summary")).toThrow(/Unknown job/);
  });
});

describe("spawnWorkerProcess", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("starts a detached node process running `<entry> worker --job <id>` with its own log file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-spawn-"));
    dirs.push(home);
    const config: Config = loadConfig({ SPURHUND_HOME: home });
    const marker = path.join(home, "argv.json");
    const entry = path.join(home, "fake-entry.mjs");
    fs.writeFileSync(entry, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))); console.log("worker log line");`);
    const prev = process.argv[1];
    process.argv[1] = entry;
    try {
      spawnWorkerProcess(config, "job_0123456789ab");
    } finally {
      process.argv[1] = prev!;
    }
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(["worker", "--job", "job_0123456789ab"]);
    await new Promise((r) => setTimeout(r, 100));
    const logFile = path.join(config.logsDir, "worker-job_0123456789ab.log");
    expect(fs.readFileSync(logFile, "utf8")).toContain("worker log line");
    if (process.platform !== "win32") expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
  });
});
