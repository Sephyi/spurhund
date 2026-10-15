import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertClaudeAuth, type Config } from "./config.js";
import type { JobRow, JobStats, Store } from "./db/store.js";
import { TERMINAL_STATES } from "./db/store.js";
import type { Logger } from "./log.js";
import type { ReportJson } from "./worker/report.js";
import { clip, errorMessage, pidAlive } from "./util.js";

export interface JobControllerDeps {
  config: Config;
  store: Store;
  log: Logger;
  /** Starts a detached worker process for the job. Injected in tests. */
  spawnWorker: (jobId: string) => void;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
}

export interface StartResult {
  jobId: string;
  queued: boolean;
  capUsd: number;
  note?: string;
}

export interface JobStatus {
  job: JobRow;
  question: string;
  depth: string;
  elapsedSeconds: number | null;
  stats: JobStats;
  recentEvents: { ts: string; phase: string; message: string }[];
  queuePosition?: number;
}

export const FULL_RESULT_LIMIT = 100_000;
/** How long a spawned worker may take to claim its job before the job is failed. */
export const SPAWN_GRACE_MS = 60_000;
export const reportUri = (jobId: string, ext: "md" | "json") => `spurhund://reports/${jobId}.${ext}`;

export class JobController {
  private readonly isAlive: (pid: number) => boolean;

  constructor(private readonly d: JobControllerDeps) {
    this.isAlive = d.isAlive ?? pidAlive;
  }

  /**
   * Housekeeping for every entry point: fails jobs whose worker died or never started,
   * then starts workers for queued jobs while there is capacity.
   */
  reap(): string[] {
    const { store } = this.d;
    const ended = [...store.reapDeadJobs(this.isAlive), ...store.failUnclaimed(SPAWN_GRACE_MS)];
    this.dispatch();
    return ended;
  }

  /** Starts a worker for each waiting job that fits under the concurrency limit. */
  private dispatch(): void {
    const { store, config } = this.d;
    for (const job of store.listUnspawned()) {
      if (!store.markSpawned(job.id, config.maxConcurrentJobs, SPAWN_GRACE_MS)) break; // no capacity
      try {
        this.d.spawnWorker(job.id);
      } catch (err) {
        store.finishJob(job.id, "failed", `Could not start the worker process: ${errorMessage(err)}`);
        this.d.log.error(`Could not start a worker for ${job.id}: ${errorMessage(err)}`);
      }
    }
  }

  start(planId: string, opts: { maxExaUsd?: number } = {}): StartResult {
    const { store, config } = this.d;
    this.reap();
    const plan = store.getPlan(planId);
    if (!plan) throw new Error(`Unknown plan ${planId}. Create one with plan_research first.`);
    if (plan.status !== "awaiting_approval") throw new Error(`Plan ${planId} was already started.`);
    if (opts.maxExaUsd !== undefined && opts.maxExaUsd > plan.maxExaUsd + 1e-9) {
      throw new Error(`max_exa_usd cannot exceed the $${plan.maxExaUsd.toFixed(2)} cap this plan was validated for; plan again with a higher cap.`);
    }
    assertClaudeAuth(config);

    const capUsd = opts.maxExaUsd ?? plan.maxExaUsd;
    const jobId = store.createJob({
      planId,
      authMode: config.auth.mode,
      models: { orchestrator: config.models.orchestrator, worker: config.models.worker, verifier: config.models.verifier },
      maxExaUsd: capUsd,
    });

    this.dispatch();
    const job = store.getJob(jobId)!;
    if (job.state === "failed") throw new Error(job.error ?? "Could not start the worker process.");
    const queued = job.spawnedAt === null;
    const running = store.listJobsByState("working").length;
    let note: string | undefined;
    if (queued) note = `${running} job(s) are already running or starting (limit ${config.maxConcurrentJobs}); this one starts when a worker is free.`;
    if (capUsd < plan.worstCaseUsd - 1e-9) {
      note = `${note ? `${note} ` : ""}The cap ($${capUsd.toFixed(2)}) is below the plan's worst case ($${plan.worstCaseUsd.toFixed(2)}); Exa work stops when it is reached and the result will be partial.`;
    }
    return { jobId, queued, capUsd, note };
  }

  status(jobId: string): JobStatus | undefined {
    this.reap();
    const job = this.d.store.getJob(jobId);
    return job ? this.statusOf(job) : undefined;
  }

  private statusOf(job: JobRow): JobStatus {
    const { store } = this.d;
    const jobId = job.id;
    const plan = store.getPlan(job.planId)!;
    const startedAt = job.startedAt ? Date.parse(job.startedAt) : null;
    const endedAt = job.finishedAt ? Date.parse(job.finishedAt) : (this.d.now?.() ?? new Date()).getTime();
    const status: JobStatus = {
      job,
      question: plan.question,
      depth: plan.depth,
      elapsedSeconds: startedAt === null ? null : Math.max(0, Math.round((endedAt - startedAt) / 1000)),
      stats: store.jobStats(jobId),
      recentEvents: store.listEvents(jobId, 5),
    };
    if (job.state === "submitted") {
      status.queuePosition = store.listJobsByState("submitted").findIndex((j) => j.id === jobId) + 1;
    }
    return status;
  }

  cancel(jobId: string): { state: string; message: string } {
    const { store } = this.d;
    // No reap() first: a job whose worker died should turn into "canceled" below, not "failed".
    const job = store.getJob(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}.`);
    if (TERMINAL_STATES.includes(job.state)) return { state: job.state, message: `Job ${jobId} already ${job.state}.` };
    if (job.state === "submitted" && store.cancelSubmitted(jobId)) {
      store.addEvent(jobId, "submitted", "Canceled before a worker picked it up.");
      return { state: "canceled", message: `Job ${jobId} was canceled before it started.` };
    }
    // A worker claimed it between the read and the update: fall through to a normal cancel request.
    store.requestCancel(jobId);
    store.addEvent(jobId, job.phase, "Cancel requested.");
    if (job.pid !== null && !this.isAlive(job.pid)) {
      this.reap();
      return { state: "canceled", message: `Job ${jobId} was canceled (its worker had already exited).` };
    }
    return {
      state: "working",
      message: `Cancel requested for ${jobId}. The worker stops within a few seconds, ends running Exa Agent runs and keeps partial results readable.`,
    };
  }

  list(limit = 10): JobStatus[] {
    this.reap();
    return this.d.store.listJobs(limit).map((j) => this.statusOf(j));
  }

  result(jobId: string, format: "summary" | "full"): { text: string; found: boolean } {
    const { store } = this.d;
    this.reap();
    const job = store.getJob(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}.`);
    const report = store.getReport(jobId);
    if (!report) {
      return {
        found: false,
        text: TERMINAL_STATES.includes(job.state)
          ? `Job ${jobId} ${job.state}${job.error ? ` (${job.error})` : ""} and has no report.`
          : `Job ${jobId} is ${job.state} (phase: ${job.phase}); the report appears when it finishes. Check research_status.`,
      };
    }
    if (format === "full") {
      const body = clip(report.markdown, FULL_RESULT_LIMIT);
      const link = report.markdown.length > FULL_RESULT_LIMIT ? `\n\nFull text: resource ${reportUri(jobId, "md")}` : "";
      return { found: true, text: body + link };
    }
    return { found: true, text: summarize(report.json as ReportJson) };
  }
}

/** Short version of a report: answer, counts, the best findings, gaps, costs. */
export function summarize(r: ReportJson): string {
  const L: string[] = [];
  L.push(`# ${r.question}`, `Job ${r.jobId} · ${r.state} · ${r.depth}`);
  if (r.partial) L.push(`PARTIAL: ${r.partialReason}.`);
  L.push("", r.summary ?? "(no summary was generated)");
  const c = r.counts;
  L.push("", `Findings: ${c.total} (${c.verified} verified, ${c.single_source} single source, ${c.unverified} unverified, ${c.contradicted} contradicted${c.unchecked ? `, ${c.unchecked} not checked` : ""}).`);
  const rank = { verified: 0, single_source: 1, unchecked: 2, unverified: 3, contradicted: 4 } as const;
  const top = [...r.findings].sort((a, b) => Number(b.critical) - Number(a.critical) || rank[a.verification] - rank[b.verification] || a.id - b.id).slice(0, 10);
  for (const f of top) {
    L.push(`- #${f.id} [${f.verification.replace("_", " ")}${f.critical ? ", critical" : ""}] ${f.claim} (${f.sources.map((s) => s.url).slice(0, 2).join(" ")})`);
  }
  if (r.findings.length > top.length) L.push(`… ${r.findings.length - top.length} more in the full report.`);
  if (r.gaps.length) L.push("", "Open gaps:", ...r.gaps.slice(0, 8).map((g) => `- ${g.description}`));
  L.push("", `Cost: Exa $${r.costs.exaUsd.toFixed(2)}, Brave $${r.costs.braveUsd.toFixed(2)}, Claude ~$${r.costs.claudeEstimateUsd.toFixed(2)} (${r.settings.authMode}).`);
  L.push(`Full report: resource ${reportUri(r.jobId, "md")} (JSON: ${reportUri(r.jobId, "json")}).`);
  return L.join("\n");
}

export function formatStatus(s: JobStatus): string {
  const j = s.job;
  const L = [
    `Job ${j.id}: ${j.state}${j.state === "working" ? ` (${j.phase})` : ""}${j.error ? ` · ${j.error}` : ""}`,
    `Question: ${s.question}`,
    `Depth ${s.depth}${s.elapsedSeconds !== null ? ` · ${Math.floor(s.elapsedSeconds / 60)} min ${s.elapsedSeconds % 60} s` : ""}${s.queuePosition ? ` · queue position ${s.queuePosition}` : ""}`,
    `So far: ${s.stats.sources} sources, ${s.stats.findings} findings, ${s.stats.gaps} gaps, ${s.stats.exaRuns} Exa run(s).`,
    `Spend: Exa $${s.stats.exaCostUsd.toFixed(3)} of $${j.maxExaUsd.toFixed(2)}, Brave $${s.stats.braveCostUsd.toFixed(3)}, Claude ~$${j.claudeCostUsd.toFixed(2)} (${j.authMode}).`,
  ];
  if (s.recentEvents.length) L.push("Recent:", ...s.recentEvents.map((e) => `  ${e.ts.slice(11, 19)} ${e.phase}: ${e.message}`));
  if (TERMINAL_STATES.includes(j.state)) L.push(`Result: call research_result (resource ${reportUri(j.id, "md")}).`);
  return L.join("\n");
}

/** Spawns `<this entry point> worker --job <id>` detached, logging to the job's own file. */
export function spawnWorkerProcess(config: Config, jobId: string): void {
  fs.mkdirSync(config.logsDir, { recursive: true });
  const logFd = fs.openSync(path.join(config.logsDir, `worker-${jobId}.log`), "a", 0o600);
  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine the spurhund entry point to start a worker.");
  const child = spawn(process.execPath, [...process.execArgv, entry, "worker", "--job", jobId], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  fs.closeSync(logFd);
}
