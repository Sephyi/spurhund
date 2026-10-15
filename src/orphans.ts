import { agentWorstCase, type AgentEffortName } from "./costs.js";
import type { Store } from "./db/store.js";
import { isTerminalRun, type AgentRunLike, type ExaEngine } from "./engines/exa.js";
import type { Plan } from "./worker/plan.js";
import { errorMessage } from "./util.js";

export type OrphanExa = Pick<ExaEngine, "agentEnd" | "agentGet">;

/**
 * Ends and settles Exa Agent runs that a dead worker left open. Only the worker tracks its runs in
 * memory, so without this a crash would leave a metered run spending and its cost at $0.
 * A run whose final cost cannot be read is charged at its worst case, like an abandoned one.
 */
export async function endOrphanedExaRuns(store: Store, exa: OrphanExa, isAlive: (pid: number) => boolean): Promise<string[]> {
  const ended: string[] = [];
  for (const row of store.listOpenRunsOfEndedJobs()) {
    if (row.pid !== null && isAlive(row.pid)) continue; // its worker is still cleaning up
    const effort = row.effort as AgentEffortName;
    const planned = (store.getPlan(row.planId)?.plan as Plan | undefined)?.exaRuns.find((r) => r.id === row.planRunId);
    const worstCase = agentWorstCase(effort, planned?.budgetUsd ?? undefined);
    let run: AgentRunLike | undefined;
    let error: string | undefined;
    try {
      run = await exa.agentEnd(row.id, effort);
    } catch (err) {
      error = errorMessage(err);
    }
    if (!run || !isTerminalRun(run) || run.costDollars?.total === undefined) {
      run = await exa.agentGet(row.id).catch(() => run);
    }
    const terminal = run !== undefined && isTerminalRun(run);
    const cost = terminal && run?.costDollars?.total !== undefined ? run.costDollars.total : worstCase;
    const status = terminal ? run!.status : "abandoned";
    const reason = `ended after its worker died${error ? ` (${error})` : ""}`;
    store.upsertExaRun({ id: row.id, jobId: row.jobId, planRunId: row.planRunId, effort: row.effort, status, stopReason: run?.stopReason ?? null, costUsd: cost, output: terminal ? run!.output : undefined, error: reason, finished: true });
    store.recordCall({ jobId: row.jobId, engine: "exa", endpoint: "agent", query: row.planRunId, ok: false, error: reason, latencyMs: 0, costUsd: cost });
    store.addEvent(row.jobId, "cleanup", `Exa run ${row.planRunId} ${reason}; charged $${cost.toFixed(3)}.`);
    ended.push(row.id);
  }
  return ended;
}
