import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/db/store.js";
import { ExaEngine } from "../src/engines/exa.js";
import { endOrphanedExaRuns } from "../src/orphans.js";
import { computeWorstCase, type Plan } from "../src/worker/plan.js";
import { fakeExaClient, harness } from "./helpers.js";

function orphanSetup(get: (id: string) => unknown) {
  const store = Store.memory();
  const plan = { segments: [], exaRuns: [{ id: "list", effort: "auto", budgetUsd: 2 }] };
  const planId = store.createPlan({ question: "q", depth: "standard", plan, worstCaseUsd: 2, maxExaUsd: 5 });
  const jobId = store.createJob({ planId, authMode: "oauth", models: {}, maxExaUsd: 5 });
  store.claimJob(jobId, 999);
  store.upsertExaRun({ id: "run_9", jobId, planRunId: "list", effort: "auto", status: "running" });
  store.finishJob(jobId, "failed", "Worker process 999 is gone; the job did not finish.");
  const client = fakeExaClient({ get: get as never });
  const exa = new ExaEngine(client, { retry: { sleepFn: async () => {} } });
  return { store, jobId, client, exa };
}

describe("orphaned Exa runs", () => {
  it("ends a run left open by a dead worker and charges its reported cost", async () => {
    const { store, jobId, client, exa } = orphanSetup((id) => ({ id, status: "cancelled", costDollars: { total: 0.3 } }));
    expect(await endOrphanedExaRuns(store, exa, () => false)).toEqual(["run_9"]);
    expect(client.agent.runs.cancel).toHaveBeenCalledWith("run_9");
    expect(store.getExaRun("run_9")).toMatchObject({ status: "cancelled", costUsd: 0.3 });
    expect(store.getExaRun("run_9")!.finishedAt).not.toBeNull();
    expect(store.sumCost(jobId, "exa")).toBeCloseTo(0.3);
    // A second pass finds nothing left to do.
    expect(await endOrphanedExaRuns(store, exa, () => false)).toEqual([]);
  });

  it("charges the planned worst case when the final cost cannot be read", async () => {
    const { store, jobId, client, exa } = orphanSetup(() => { throw new Error("network down"); });
    client.agent.runs.cancel.mockRejectedValue(new Error("network down"));
    await endOrphanedExaRuns(store, exa, () => false);
    expect(store.getExaRun("run_9")).toMatchObject({ status: "abandoned", costUsd: 2 });
    expect(store.sumCost(jobId, "exa")).toBeCloseTo(2);
  });

  it("leaves runs alone while their worker is still alive", async () => {
    const { store, client, exa } = orphanSetup((id) => ({ id, status: "cancelled" }));
    expect(await endOrphanedExaRuns(store, exa, () => true)).toEqual([]);
    expect(client.agent.runs.cancel).not.toHaveBeenCalled();
  });
});

describe("agentStart after a failed DB write", () => {
  it("ends the created run and keeps its worst case charged", async () => {
    const h = harness({ job: { cap: 5 }, engines: ["exa"] });
    vi.spyOn(h.store, "upsertExaRun").mockImplementation(() => { throw new Error("SQLITE_FULL"); });
    try {
      await expect(h.core.agentStart("r1", { query: "List ML-KEM crates", effort: "high" })).rejects.toThrow("SQLITE_FULL");
      expect(h.exaClient.agent.runs.cancel).toHaveBeenCalledWith("run_1");
      expect(h.core.ledger!.spent).toBeCloseTo(0.5);
    } finally { h.store.close(); }
  });
});

describe("worst-case estimate", () => {
  const plan = (n: number) => ({ segments: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, engines: ["exa", "brave"] })), exaRuns: [] }) as unknown as Plan;
  it.each([["deep", 6], ["exhaustive", 10]] as const)("fits a full %s plan (%i segments) under the default $5 cap", (depth, n) => {
    expect(computeWorstCase(plan(n), depth).totalExaUsd).toBeLessThan(5);
  });
});
