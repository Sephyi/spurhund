import type { JobRow } from "../db/store.js";
import { runJob, type PipelineDeps } from "./pipeline.js";

/**
 * Worker process body: runs the given job, then keeps taking submitted jobs
 * until none are left or the process is told to stop.
 */
export async function workerMain(deps: PipelineDeps, firstJobId?: string): Promise<number> {
  const { store, log } = deps;
  const pid = process.pid;
  let job: JobRow | undefined = firstJobId ? store.claimJob(firstJobId, pid) : store.claimNextSubmitted(pid);
  if (firstJobId && !job) {
    log.warn(`Job ${firstJobId} is not waiting for a worker (already taken, finished or unknown).`);
    job = store.claimNextSubmitted(pid);
  }
  let ran = 0;
  while (job) {
    log.info(`worker ${pid} starts ${job.id}`);
    await runJob(deps, job);
    ran++;
    if (deps.signal?.aborted) break;
    job = store.claimNextSubmitted(pid);
  }
  log.info(`worker ${pid} done (${ran} job(s))`);
  return ran;
}
