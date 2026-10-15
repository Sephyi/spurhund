import fs from "node:fs";
import path from "node:path";
import type { Config, EngineId } from "../config.js";
import { Core } from "../core.js";
import { CostLedger } from "../costs.js";
import type { JobRow, Store } from "../db/store.js";
import { isTerminalRun, type AgentRunLike, type AgentRunRequest, type ExaEngine } from "../engines/exa.js";
import type { Engine } from "../engines/types.js";
import type { Logger } from "../log.js";
import { Limiter, errorMessage } from "../util.js";
import type { Depth, Plan } from "./plan.js";
import {
  MergeResultSchema,
  NarrativeSchema,
  gapPrompt,
  jsonSchemaOf,
  mergePrompt,
  reportPrompt,
  segmentPrompt,
  sharedRules,
  verifyPrompt,
  type MergeResult,
  type Narrative,
} from "./prompts.js";
import { buildReport } from "./report.js";
import type { AgentRunner, RunRequest, RunResult } from "./runner.js";
import { buildToolset } from "./tools.js";

export interface PipelineDeps {
  config: Config;
  store: Store;
  engines: Partial<Record<EngineId, Engine>>;
  exa?: ExaEngine;
  runner: AgentRunner;
  log: Logger;
  /** Aborts the job (SIGTERM). A cancel request in the database aborts it too. */
  signal?: AbortSignal;
  pollMs?: number;
  cancelPollMs?: number;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
}

export type JobOutcome = "completed" | "failed" | "canceled";

class CanceledError extends Error {
  constructor() {
    super("canceled");
    this.name = "CanceledError";
  }
}

const SEGMENT_CONCURRENCY = 4;
const SEGMENT_TURNS: Record<Depth, number> = { standard: 60, deep: 90, exhaustive: 120 };
const MERGE_TURNS = 60;
const GAP_TURNS = 50;
const VERIFY_TURNS = 150;
const REPORT_TURNS = 10;
const EXA_RUN_TIMEOUT_MS = 25 * 60_000;
const MAX_POLL_FAILURES = 5;
/** Polls after stop/cancel before a run is given up and charged at its worst case. */
const END_POLLS = 6;
const PROGRESS_EVENT_INTERVAL_MS = 10_000;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function runJob(deps: PipelineDeps, job: JobRow): Promise<JobOutcome> {
  const { config, store, runner, log } = deps;
  const planRow = store.getPlan(job.planId);
  if (!planRow) {
    store.finishJob(job.id, "failed", `Plan ${job.planId} is missing.`);
    return "failed";
  }
  const plan = planRow.plan as Plan;
  const depth = planRow.depth as Depth;
  const nap = deps.sleepFn ?? abortableSleep;
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);

  const ledger = new CostLedger(job.maxExaUsd, store.sumCost(job.id, "exa"));
  const core = new Core({ config, store, engines: deps.engines, exa: deps.exa, jobId: job.id, ledger });

  // One abort signal for SIGTERM and for a cancel request written by the MCP server.
  const ac = new AbortController();
  const signal = ac.signal;
  const onAbort = () => ac.abort();
  if (deps.signal?.aborted) ac.abort();
  else deps.signal?.addEventListener("abort", onAbort, { once: true });
  const watcher = setInterval(() => {
    if (store.isCancelRequested(job.id)) ac.abort();
  }, deps.cancelPollMs ?? 2000);
  watcher.unref?.();

  const event = (phase: string, message: string) => {
    store.addEvent(job.id, phase, message);
    log.info(`[${job.id}] ${phase}: ${message}`);
  };
  const phase = (name: string, message: string) => {
    store.setPhase(job.id, name);
    event(name, message);
  };
  const guard = () => {
    if (signal.aborted || store.isCancelRequested(job.id)) throw new CanceledError();
  };
  const lastProgress = new Map<string, number>();
  const progress = (label: string, message: string) => {
    const now = Date.now();
    if (now - (lastProgress.get(label) ?? 0) < PROGRESS_EVENT_INTERVAL_MS) return;
    lastProgress.set(label, now);
    store.addEvent(job.id, store.getJob(job.id)?.phase ?? "working", message);
  };

  // URLs the user wrote themselves may be fetched even though no search returned them.
  core.seedUserUrls(`${plan.question}\n${plan.notes ?? ""}`);

  const rules = sharedRules({ today, languages: plan.languages, window: plan.timeWindow });
  let claudeReserved = 0;
  let segmentsRemaining = plan.segments.length;
  let claudeCapReached = false;

  const session = async (req: Omit<RunRequest, "systemPrompt" | "signal" | "onProgress">): Promise<RunResult> => {
    const remaining = config.claudeMaxUsdPerJob - store.getJob(job.id)!.claudeCostUsd - claudeReserved;
    const slots = req.role === "segment" ? Math.min(SEGMENT_CONCURRENCY, segmentsRemaining--) : 1;
    if (remaining <= 0 && req.role !== "report") {
      claudeCapReached = true;
      const message = `Claude usage cap reached before ${req.label}`;
      event(store.getJob(job.id)?.phase ?? "working", message);
      store.addGap(job.id, req.label, message);
      return { ok: false, text: "", costUsd: 0, turns: 0, subtype: "claude_cap_reached", errors: [] };
    }
    let maxBudgetUsd = Math.min(req.maxBudgetUsd ?? config.maxBudgetUsd ?? Infinity, remaining / slots);
    // A final narrative is still useful after exhaustion, and may exceed the job cap by $0.15.
    if (req.role === "report") maxBudgetUsd = Math.max(0.15, maxBudgetUsd);
    claudeReserved += maxBudgetUsd;
    const started = Date.now();
    let res: RunResult;
    try {
      res = await runner.run({ ...req, maxBudgetUsd, systemPrompt: rules, signal, onProgress: (message) => progress(req.label, message) });
    } finally {
      claudeReserved -= maxBudgetUsd;
    }
    store.addClaudeCost(job.id, res.costUsd);
    store.addClaudeSession({ jobId: job.id, role: req.role, label: req.label, costUsd: res.costUsd, turns: res.turns, subtype: res.subtype, durationMs: Date.now() - started });
    if (res.subtype === "error_max_budget_usd" || (req.role !== "report" && store.getJob(job.id)!.claudeCostUsd >= config.claudeMaxUsdPerJob)) claudeCapReached = true;
    if (!res.ok && !signal.aborted) event(store.getJob(job.id)?.phase ?? "working", `${req.label} ended with ${res.subtype}${res.errors.length ? `: ${res.errors.join("; ")}` : ""}`);
    return res;
  };

  // ------------------------------------------------------------- phases

  const runSegment = async (segmentId: string) => {
    const res = await session({
      role: "segment",
      label: `segment:${segmentId}`,
      model: config.models.worker,
      effort: config.efforts.worker,
      prompt: segmentPrompt({ plan, segmentId, depth }),
      tools: buildToolset("segment", { core, store, jobId: job.id, segment: segmentId, engines: plan.segments.find((x) => x.id === segmentId)?.engines }),
      maxTurns: Math.min(config.maxTurns, SEGMENT_TURNS[depth]),
    });
    if (!res.ok && !signal.aborted) {
      store.addGap(job.id, segmentId, `The research session for this segment ended early (${res.subtype}); coverage here may be thin.`);
    }
  };

  /**
   * Ends a run at Exa (stop for ultra, cancel otherwise) and waits briefly for its final
   * state. A run that never reports one is charged at its worst case: it may still be running.
   */
  const endRun = async (planRunId: string, runId: string): Promise<AgentRunLike | undefined> => {
    let last: AgentRunLike | undefined;
    try {
      last = await core.agentEnd(runId);
    } catch (err) {
      log.warn(`Exa run ${runId}: stop/cancel failed (${errorMessage(err)})`);
    }
    for (let i = 0; i < END_POLLS && !(last && isTerminalRun(last)); i++) {
      await nap(deps.pollMs ?? 5000); // deliberately not abortable: this runs while the job is being canceled
      try {
        last = await core.agentGet(runId);
      } catch {
        // keep trying until END_POLLS is used up
      }
    }
    if (core.agentIsOpen(runId)) {
      const charged = core.agentAbandon(runId, "no final state after stop/cancel");
      event("execute", `Exa run ${planRunId} did not confirm that it stopped; charged its worst case ($${charged.toFixed(2)})`);
      store.addGap(job.id, "exa-agent", `Exa run ${planRunId} did not confirm that it stopped. Its worst case ($${charged.toFixed(2)}) was charged; check the Exa dashboard.`);
    }
    return last;
  };

  const runExaRun = async (r: Plan["exaRuns"][number]) => {
    const planRunId = r.id;
    let runId: string | undefined;
    try {
      const request: AgentRunRequest = {
        query: r.query,
        systemPrompt: r.systemPrompt ?? undefined,
        effort: r.effort,
        budgetUsd: r.budgetUsd ?? undefined,
        maxDurationSeconds: r.maxDurationSeconds ?? undefined,
        outputSchema: r.outputSchemaJson ? (JSON.parse(r.outputSchemaJson) as Record<string, unknown>) : undefined,
      };
      const started = await core.agentStart(planRunId, request);
      runId = started.id;
      event("execute", `Exa run ${planRunId} started (${r.effort}, id ${started.id})`);
      const deadline = Date.now() + (r.effort === "ultra" ? (r.maxDurationSeconds ?? 3600) * 1000 + 10 * 60_000 : EXA_RUN_TIMEOUT_MS);
      let current: AgentRunLike | undefined = started;
      let pollFailures = 0;
      while (current && !isTerminalRun(current)) {
        if (signal.aborted) {
          current = await endRun(planRunId, started.id);
          break;
        }
        await nap(deps.pollMs ?? 5000, signal);
        if (signal.aborted) continue;
        try {
          current = await core.agentGet(started.id);
          pollFailures = 0;
        } catch (err) {
          log.warn(`Exa run ${started.id}: poll failed (${errorMessage(err)})`);
          if (++pollFailures >= MAX_POLL_FAILURES) {
            event("execute", `Exa run ${planRunId}: ${pollFailures} polls failed in a row; ending it`);
            current = await endRun(planRunId, started.id);
            break;
          }
        }
        if (current && !isTerminalRun(current) && Date.now() > deadline) {
          event("execute", `Exa run ${planRunId} reached its local time limit; ending it`);
          current = await endRun(planRunId, started.id);
          store.addGap(job.id, "exa-agent", `Exa run ${planRunId} was ended at the local time limit; its result may be partial.`);
        }
      }
      if (!current || !isTerminalRun(current)) return; // abandoned and charged by endRun
      if (current.status !== "completed") {
        if (!signal.aborted) store.addGap(job.id, "exa-agent", `Exa run ${planRunId} ended with status ${current.status}${current.error?.message ? `: ${current.error.message}` : ""}.`);
      } else if (current.stopReason === "budget_reached" || current.stopReason === "time_limit_reached") {
        store.addGap(job.id, "exa-agent", `Exa run ${planRunId} stopped at its ${current.stopReason === "budget_reached" ? "budget" : "time"} limit; its list may be partial.`);
      }
      event("execute", `Exa run ${planRunId} finished: ${current.status}${current.stopReason ? ` (${current.stopReason})` : ""}`);
    } catch (err) {
      // Whatever went wrong, a run that was started must not keep running unaccounted.
      if (runId && core.agentIsOpen(runId)) await endRun(planRunId, runId);
      if (signal.aborted) return;
      const msg = errorMessage(err);
      event("execute", `Exa run ${planRunId} failed: ${msg}`);
      store.addGap(job.id, "exa-agent", `Exa run ${planRunId} could not be completed (${msg}).`);
    }
  };

  const execute = async () => {
    const limiter = new Limiter(SEGMENT_CONCURRENCY);
    const settled = await Promise.allSettled([
      ...plan.exaRuns.map((r) => runExaRun(r)),
      ...plan.segments.map((s) => limiter.run(() => runSegment(s.id))),
    ]);
    const rejected = settled.find((r) => r.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  };

  const merge = async (): Promise<MergeResult | undefined> => {
    const exaRunIds = store.listExaRuns(job.id).filter((r) => r.status === "completed").map((r) => r.planRunId);
    if (store.listFindings(job.id).length === 0 && exaRunIds.length === 0) return undefined;
    const res = await session({
      role: "merge",
      label: "merge",
      model: config.models.orchestrator,
      effort: config.efforts.orchestrator,
      prompt: mergePrompt({ plan, exaRunIds }),
      tools: buildToolset("merge", { core, store, jobId: job.id, segment: "exa-agent" }),
      outputSchema: jsonSchemaOf(MergeResultSchema),
      maxTurns: Math.min(config.maxTurns, MERGE_TURNS),
    });
    const parsed = MergeResultSchema.safeParse(res.structured);
    return parsed.success ? parsed.data : undefined;
  };

  const gapPass = async (mergeResult: MergeResult | undefined) => {
    await session({
      role: "gap",
      label: "gap-pass",
      model: config.models.worker,
      effort: config.efforts.worker,
      prompt: gapPrompt({ plan, merge: mergeResult, depth }),
      tools: buildToolset("gap", { core, store, jobId: job.id, segment: "gap-pass" }),
      maxTurns: Math.min(config.maxTurns, GAP_TURNS),
    });
  };

  const verify = async () => {
    await session({
      role: "verify",
      label: "verify",
      model: config.models.verifier,
      effort: config.efforts.verifier,
      prompt: verifyPrompt({ plan, gaps: store.listGaps(job.id).filter((g) => g.resolvedNote === null) }),
      tools: buildToolset("verify", { core, store, jobId: job.id, segment: "verification" }),
      maxTurns: Math.min(config.maxTurns, VERIFY_TURNS),
    });
    // Anything the verifier did not get to is reported as unchecked, never as fine.
    for (const f of store.listFindings(job.id)) {
      if (f.verification === "unchecked") store.setVerification(f.id, "unverified", "Not checked in the verification pass.");
    }
  };

  const narrate = async (): Promise<Narrative | undefined> => {
    const res = await session({
      role: "report",
      label: "report",
      model: config.models.orchestrator,
      effort: config.efforts.orchestrator,
      prompt: reportPrompt({ plan, state: claudeCapReached ? "partial: Claude usage cap reached" : "completed" }),
      tools: buildToolset("report", { core, store, jobId: job.id }),
      outputSchema: jsonSchemaOf(NarrativeSchema),
      maxTurns: Math.min(config.maxTurns, REPORT_TURNS),
    });
    const parsed = NarrativeSchema.safeParse(res.structured);
    return parsed.success ? parsed.data : undefined;
  };

  const writeReport = (
    narrative: Narrative | undefined,
    mergeResult: MergeResult | undefined,
    final: { state: JobOutcome; error?: string },
  ) => {
    const fresh: JobRow = {
      ...store.getJob(job.id)!,
      state: final.state,
      error: final.error ?? null,
      finishedAt: (deps.now?.() ?? new Date()).toISOString(),
    };
    store.refreshEvidence(job.id);
    const { markdown, json } = buildReport(store, { job: fresh, planRow, narrative, merge: mergeResult, config, partialReason: claudeCapReached ? "Claude usage cap reached" : undefined });
    store.saveReport(job.id, markdown, json);
    try {
      fs.mkdirSync(config.reportsDir, { recursive: true });
      fs.writeFileSync(path.join(config.reportsDir, `${job.id}.md`), markdown, { mode: 0o600 });
      fs.writeFileSync(path.join(config.reportsDir, `${job.id}.json`), JSON.stringify(json, null, 2), { mode: 0o600 });
    } catch (err) {
      log.warn(`Could not write report files: ${errorMessage(err)}`);
    }
  };

  // ---------------------------------------------------------- the run

  let outcome: JobOutcome = "completed";
  let failure: string | undefined;
  let mergeResult: MergeResult | undefined;
  let narrative: Narrative | undefined;
  try {
    phase("execute", `Researching ${plan.segments.length} segment(s) and ${plan.exaRuns.length} Exa run(s) in parallel`);
    await execute();
    guard();

    phase("merge", "Merging findings and reading Exa run results");
    mergeResult = await merge();
    guard();

    if (depth !== "standard" && store.listFindings(job.id).length > 0) {
      phase("gap", "Closing gaps with targeted follow-up searches");
      await gapPass(mergeResult);
      guard();
    }

    if (store.listFindings(job.id).length > 0) {
      phase("verify", "Verifying findings");
      await verify();
      guard();
    }

    phase("report", "Writing the report");
    narrative = await narrate();
    guard();
  } catch (err) {
    if (err instanceof CanceledError || signal.aborted) {
      outcome = "canceled";
    } else {
      outcome = "failed";
      failure = errorMessage(err);
      log.error(`[${job.id}] failed: ${failure}`);
    }
  } finally {
    clearInterval(watcher);
    deps.signal?.removeEventListener("abort", onAbort);
  }

  // A partial report is written for canceled and failed jobs too. It is built
  // with the final outcome before the state is committed, so a job is only
  // "completed" when its report exists.
  try {
    writeReport(narrative, mergeResult, { state: outcome, error: failure });
  } catch (err) {
    log.error(`[${job.id}] could not build the report: ${errorMessage(err)}`);
    if (outcome === "completed") {
      outcome = "failed";
      failure = `The report could not be built: ${errorMessage(err)}`;
    }
  }
  store.finishJob(job.id, outcome, failure);
  event("done", `Job ${outcome}`);
  return outcome;
}
