import { assertClaudeAuth, type Config } from "../config.js";
import { Core, NoEngineError } from "../core.js";
import { CostLedger } from "../costs.js";
import type { Store } from "../db/store.js";
import type { ExaEngine } from "../engines/exa.js";
import type { Engine } from "../engines/types.js";
import type { EngineId } from "../config.js";
import type { Logger } from "../log.js";
import { DEPTHS, PlanSchema, formatPlan, validatePlan, type Depth, type Plan, type WorstCase } from "./plan.js";
import { jsonSchemaOf, plannerPrompt, plannerSystem } from "./prompts.js";
import type { AgentRunner } from "./runner.js";
import { buildToolset } from "./tools.js";

export interface PlanRequest {
  question: string;
  depth?: Depth;
  /** Languages beyond English and German that the user approved. */
  languages?: string[];
  timeWindow?: { from?: string; to?: string };
  maxExaUsd?: number;
  allowUltra?: boolean;
  notes?: string;
}

export interface PlannerDeps {
  config: Config;
  store: Store;
  engines: Partial<Record<EngineId, Engine>>;
  exa?: ExaEngine;
  runner: AgentRunner;
  log: Logger;
  today?: () => Date;
  timeoutMs?: number;
}

export interface PlanResult {
  planId: string;
  plan: Plan;
  depth: Depth;
  maxExaUsd: number;
  worstCase: WorstCase;
  text: string;
}

export class PlanError extends Error {
  constructor(
    message: string,
    public readonly problems: string[] = [],
  ) {
    super(problems.length ? `${message}\n- ${problems.join("\n- ")}` : message);
    this.name = "PlanError";
  }
}

/** Spend allowed for the planner's calibration searches. */
export const PLAN_SCOUT_BUDGET_USD = 0.3;
const PLANNER_MAX_TURNS = 20;
const DEFAULT_PLAN_TIMEOUT_MS = 200_000;

export async function planResearch(deps: PlannerDeps, req: PlanRequest): Promise<PlanResult> {
  const { config, store } = deps;
  assertClaudeAuth(config);

  const depth: Depth = req.depth ?? "standard";
  if (!DEPTHS.includes(depth)) throw new PlanError(`depth must be one of ${DEPTHS.join(", ")}`);
  // SPURHUND_EXA_MAX_USD_PER_JOB is a ceiling for every entry point (MCP and CLI), not just a default.
  if (req.maxExaUsd !== undefined && req.maxExaUsd > config.exaMaxUsdPerJob + 1e-9) {
    throw new PlanError(`max_exa_usd $${req.maxExaUsd.toFixed(2)} is above the configured ceiling of $${config.exaMaxUsdPerJob.toFixed(2)} (SPURHUND_EXA_MAX_USD_PER_JOB).`);
  }
  const maxExaUsd = req.maxExaUsd ?? config.exaMaxUsdPerJob;
  const extraLanguages = (req.languages ?? []).map((l) => l.toLowerCase()).filter((l) => l !== "en" && l !== "de");
  const today = (deps.today?.() ?? new Date()).toISOString().slice(0, 10);

  const core = new Core({ config, store, engines: deps.engines, exa: deps.exa, ledger: new CostLedger(PLAN_SCOUT_BUDGET_USD) });
  const availableEngines = core.availableEngines();
  if (availableEngines.length === 0) {
    throw new NoEngineError("Planning needs at least one search engine. Set EXA_API_KEY and/or BRAVE_API_KEY.");
  }
  const constraints = {
    depth,
    extraLanguages,
    maxExaUsd,
    allowUltra: req.allowUltra ?? false,
    availableEngines,
    exaAvailable: core.hasExa(),
  };

  const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS);
  let previous: { plan: unknown; errors: string[] } | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    // Planning precedes job creation; its usage is excluded from per-job session accounting.
    const result = await deps.runner.run({
      role: "planner",
      label: `planner#${attempt}`,
      model: config.models.orchestrator,
      effort: config.efforts.orchestrator,
      systemPrompt: plannerSystem(),
      prompt: plannerPrompt({
        question: req.question,
        depth,
        today,
        extraLanguages,
        timeWindow: req.timeWindow,
        maxExaUsd,
        allowUltra: constraints.allowUltra,
        engines: availableEngines,
        exaAvailable: constraints.exaAvailable,
        notes: req.notes,
        previous,
      }),
      tools: buildToolset("planner", { core, store }),
      outputSchema: jsonSchemaOf(PlanSchema),
      maxTurns: Math.min(config.maxTurns, PLANNER_MAX_TURNS),
      signal,
    });

    if (!result.ok) {
      const why = signal.aborted ? "timed out" : result.errors.join("; ") || result.subtype;
      throw new PlanError(`The planner session did not finish (${why}).`);
    }

    const parsed = PlanSchema.safeParse(result.structured);
    if (!parsed.success) {
      previous = { plan: result.structured, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
      deps.log.warn(`Plan attempt ${attempt} did not match the schema: ${previous.errors.join("; ")}`);
      continue;
    }

    const plan: Plan = {
      ...parsed.data,
      languages: parsed.data.languages.map((l) => l.toLowerCase()),
      segments: parsed.data.segments.map((s) => ({ ...s, languages: s.languages.map((l) => l.toLowerCase()) })),
    };
    const check = validatePlan(plan, constraints);
    if (check.errors.length) {
      previous = { plan, errors: check.errors };
      deps.log.warn(`Plan attempt ${attempt} rejected: ${check.errors.join("; ")}`);
      continue;
    }

    // The row keeps the user's own wording: the plan's question is the planner's rewrite and may drop URLs.
    const planId = store.createPlan({ question: req.question, depth, plan, worstCaseUsd: check.worstCase.totalExaUsd, maxExaUsd });
    return { planId, plan, depth, maxExaUsd, worstCase: check.worstCase, text: formatPlan(plan, depth, check.worstCase, maxExaUsd, config.claudeMaxUsdPerJob) };
  }

  throw new PlanError("The planner could not produce a valid plan after one correction.", previous?.errors ?? []);
}
