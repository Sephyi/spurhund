import { JobController, spawnWorkerProcess } from "./jobs.js";
import type { Runtime } from "./runtime.js";
import { planResearch, type PlanRequest, type PlanResult } from "./worker/planner.js";
import { ClaudeAgentRunner, type AgentRunner } from "./worker/runner.js";

export interface Services {
  runner: AgentRunner;
  jobs: JobController;
  plan: (req: PlanRequest) => Promise<PlanResult>;
}

/** Wires the planner and job controller to a runtime. `runner` is injectable for tests. */
export function buildServices(
  rt: Runtime,
  /** endOrphanedRuns: only for the long-lived server; a CLI command closes the DB before a cleanup pass could finish. */
  opts: { runner?: AgentRunner; spawnWorker?: (jobId: string) => void; endOrphanedRuns?: boolean } = {},
): Services {
  const runner = opts.runner ?? new ClaudeAgentRunner(rt.config, rt.log);
  const jobs = new JobController({
    config: rt.config,
    store: rt.store,
    log: rt.log,
    exa: opts.endOrphanedRuns ? rt.exa : undefined,
    spawnWorker: opts.spawnWorker ?? ((jobId) => spawnWorkerProcess(rt.config, jobId)),
  });
  const plan = (req: PlanRequest) =>
    planResearch({ config: rt.config, store: rt.store, engines: rt.engines, exa: rt.exa, runner, log: rt.log }, req);
  return { runner, jobs, plan };
}
