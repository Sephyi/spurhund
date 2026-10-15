import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { NoEngineError } from "../src/core.js";
import { Store } from "../src/db/store.js";
import { ConfigError } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { PLAN_SCOUT_BUDGET_USD, PlanError, planResearch, type PlannerDeps } from "../src/worker/planner.js";
import type { Plan } from "../src/worker/plan.js";
import type { AgentRunner, RunRequest, RunResult } from "../src/worker/runner.js";
import { ExaEngine } from "../src/engines/exa.js";
import { fakeBrave, fakeExaClient } from "./helpers.js";

const validPlan: Plan = {
  question: "Which Rust crates implement ML-KEM?",
  successCriteria: "A list of maintained crates with sources",
  timeWindow: { from: null, to: null },
  languages: ["en"],
  segments: [
    {
      id: "crates",
      name: "Crates on crates.io",
      objective: "Find crates implementing FIPS 203",
      angles: ["crates.io listings", "repository READMEs"],
      languages: ["en"],
      engines: ["exa", "brave"],
      seedQueries: ["Rust crate implementing ML-KEM FIPS 203 key encapsulation"],
    },
  ],
  exaRuns: [],
  notes: null,
};

class ScriptedPlanner implements AgentRunner {
  calls: RunRequest[] = [];
  constructor(private readonly replies: (Partial<RunResult> & { structured?: unknown })[]) {}
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    const reply = this.replies[Math.min(this.calls.length - 1, this.replies.length - 1)]!;
    return { ok: true, text: "", costUsd: 0, turns: 1, subtype: "success", errors: [], ...reply };
  }
}

function deps(runner: AgentRunner, over: Partial<PlannerDeps> = {}, env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: "t" }) {
  const store = Store.memory();
  const exa = new ExaEngine(fakeExaClient());
  const d: PlannerDeps = {
    config: loadConfig({ SPURHUND_HOME: "/tmp/x", ...env }),
    store,
    engines: { exa, brave: fakeBrave(() => new Response("{}")).engine },
    exa,
    runner,
    log: createLogger("error", { sink: () => {} }),
    today: () => new Date("2026-10-15T09:00:00Z"),
    ...over,
  };
  return { d, store };
}

describe("planResearch", () => {
  it("returns a stored, validated plan with its cost", async () => {
    const runner = new ScriptedPlanner([{ structured: validPlan }]);
    const { d, store } = deps(runner);
    const r = await planResearch(d, { question: "Which Rust crates implement ML-KEM?", depth: "standard" });

    expect(r.planId).toMatch(/^plan_[0-9a-f]{12}$/);
    expect(r.depth).toBe("standard");
    expect(r.maxExaUsd).toBe(5);
    expect(r.worstCase.totalExaUsd).toBeGreaterThan(0);
    expect(r.text).toContain("Segments (1):");
    expect(store.getPlan(r.planId)).toMatchObject({ status: "awaiting_approval", depth: "standard", maxExaUsd: 5 });
    expect((store.getPlan(r.planId)!.plan as Plan).segments[0]!.id).toBe("crates");
  });

  it("configures the planner session: orchestrator model, planner tools, schema, turn cap and a timeout signal", async () => {
    const runner = new ScriptedPlanner([{ structured: validPlan }]);
    const { d } = deps(runner);
    await planResearch(d, { question: "Which Rust crates implement ML-KEM?" });
    const req = runner.calls[0]!;
    expect(req).toMatchObject({ role: "planner", model: "claude-opus-5-5", effort: "high" });
    expect(req.tools.map((t) => t.name)).toEqual(["search"]);
    expect(req.outputSchema).toMatchObject({ type: "object" });
    expect(req.maxTurns).toBe(20);
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.prompt).toContain("Today is 2026-10-15");
    expect(req.prompt).toContain("Allowed languages: en, de.");
    expect(req.prompt).toContain("Ultra effort: not allowed.");
    expect(req.prompt).toContain("Available engines: exa, brave");
  });

  it("passes the user's constraints into the prompt and the validation", async () => {
    const runner = new ScriptedPlanner([{ structured: { ...validPlan, languages: ["en", "fr"], segments: [{ ...validPlan.segments[0]!, languages: ["en", "fr"] }] } }]);
    const { d } = deps(runner);
    const r = await planResearch(d, {
      question: "Which Rust crates implement ML-KEM?",
      languages: ["FR", "de", "en"],
      timeWindow: { from: "2026-01-01" },
      maxExaUsd: 2.5,
      allowUltra: true,
      notes: "only maintained crates",
    });
    expect(runner.calls[0]!.prompt).toContain("Allowed languages: en, de, fr.");
    expect(runner.calls[0]!.prompt).toContain("Time window: 2026-01-01 to open.");
    expect(runner.calls[0]!.prompt).toContain("$2.50");
    expect(runner.calls[0]!.prompt).toContain("only maintained crates");
    expect(r.maxExaUsd).toBe(2.5);
  });

  it("gives the planner one chance to correct an invalid plan and shows it what was wrong", async () => {
    const bad = { ...validPlan, languages: ["en", "ja"] };
    const runner = new ScriptedPlanner([{ structured: bad }, { structured: validPlan }]);
    const { d } = deps(runner);
    const r = await planResearch(d, { question: "Which Rust crates implement ML-KEM?" });
    expect(r.plan.languages).toEqual(["en"]);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]!.prompt).toContain("Your previous plan was rejected");
    expect(runner.calls[1]!.prompt).toContain('language "ja" is not approved');
  });

  it("also corrects output that does not match the schema", async () => {
    const runner = new ScriptedPlanner([{ structured: { question: "x" } }, { structured: validPlan }]);
    const { d } = deps(runner);
    await expect(planResearch(d, { question: "Which Rust crates implement ML-KEM?" })).resolves.toBeDefined();
    expect(runner.calls[1]!.prompt).toMatch(/successCriteria/);
  });

  it("fails with the problems listed after the second invalid plan, and stores nothing", async () => {
    const bad = { ...validPlan, segments: [] };
    const { d, store } = deps(new ScriptedPlanner([{ structured: bad }]));
    const err = await planResearch(d, { question: "Which Rust crates implement ML-KEM?" }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.message).toMatch(/after one correction/);
    expect(err.message).toMatch(/needs 1-3 segments, got 0/);
    expect(store.listJobs()).toEqual([]);
  });

  it("surfaces a planner session that did not finish", async () => {
    const { d } = deps(new ScriptedPlanner([{ ok: false, subtype: "error_max_turns", errors: ["too many turns"] }]));
    await expect(planResearch(d, { question: "Which Rust crates implement ML-KEM?" })).rejects.toThrow(/did not finish \(too many turns\)/);
  });

  it("refuses to plan without Claude credentials or without any search engine", async () => {
    await expect(planResearch(deps(new ScriptedPlanner([]), {}, {}).d, { question: "Which Rust crates implement ML-KEM?" })).rejects.toThrow(ConfigError);
    await expect(planResearch(deps(new ScriptedPlanner([]), { engines: {}, exa: undefined }).d, { question: "Which Rust crates implement ML-KEM?" })).rejects.toThrow(NoEngineError);
  });

  it("rejects an unknown depth", async () => {
    const { d } = deps(new ScriptedPlanner([{ structured: validPlan }]));
    await expect(planResearch(d, { question: "Which Rust crates implement ML-KEM?", depth: "extreme" as never })).rejects.toThrow(/depth must be one of/);
  });

  it("limits the planner's scouting spend", async () => {
    // The planner's tools run through a Core capped at PLAN_SCOUT_BUDGET_USD.
    let toolOutput = "";
    const runner: AgentRunner = {
      async run(req) {
        const search = req.tools.find((t) => t.name === "search")!;
        for (let i = 0; i < 80; i++) toolOutput = (await search.handler({ query: `scouting ${i}`, engines: ["exa"] })).text;
        return { ok: true, text: "", structured: validPlan, costUsd: 0, turns: 1, subtype: "success", errors: [] };
      },
    };
    const { d, store } = deps(runner, { exa: new ExaEngine(fakeExaClient({ search: () => ({ results: [], costDollars: { total: 0.05 } }) })) });
    d.engines.exa = d.exa;
    await planResearch(d, { question: "Which Rust crates implement ML-KEM?" });
    expect(toolOutput).toMatch(/budget/i);
    expect(PLAN_SCOUT_BUDGET_USD).toBe(0.3);
    expect(store.listJobs()).toEqual([]);
  });
});

describe("planResearch: final batch", () => {
  it("rejects an Exa cap above SPURHUND_EXA_MAX_USD_PER_JOB", async () => {
    const { d } = deps(new ScriptedPlanner([{ structured: validPlan }]), {}, { CLAUDE_CODE_OAUTH_TOKEN: "t", SPURHUND_EXA_MAX_USD_PER_JOB: "5" });
    await expect(planResearch(d, { question: "Which Rust crates implement ML-KEM?", maxExaUsd: 100 })).rejects.toThrow(/above the configured ceiling/);
  });

  it("stores the user's own question, so URLs the planner dropped can still be seeded", async () => {
    const { d, store } = deps(new ScriptedPlanner([{ structured: validPlan }]));
    const question = "Which Rust crates implement ML-KEM? Start with https://crates.io/search?q=ml-kem";
    const r = await planResearch(d, { question });
    expect(store.getPlan(r.planId)!.question).toBe(question);
  });
});
