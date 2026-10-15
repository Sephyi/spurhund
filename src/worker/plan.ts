import { z } from "zod";
import { ENGINE_IDS, type EngineId } from "../config.js";
import { AGENT_EFFORTS, agentWorstCase, estimateSegmentExaSpend, type AgentEffortName } from "../costs.js";

export const DEPTHS = ["standard", "deep", "exhaustive"] as const;
export type Depth = (typeof DEPTHS)[number];

/**
 * Plan as the planner model returns it. Deliberately free of min/max/regex
 * constraints so it converts to a JSON Schema every structured-output backend
 * accepts; {@link validatePlan} enforces the real rules and produces messages
 * the planner can act on.
 */
export const PlanSchema = z.object({
  question: z.string(),
  successCriteria: z.string().describe("What a good, complete-enough answer contains."),
  timeWindow: z.object({ from: z.string().nullable(), to: z.string().nullable() }).describe("Absolute YYYY-MM-DD dates, or null."),
  languages: z.array(z.string()).describe("ISO 639-1 codes; always includes en."),
  segments: z.array(
    z.object({
      id: z.string().describe("Short slug, lowercase letters, digits and dashes."),
      name: z.string(),
      objective: z.string(),
      angles: z.array(z.string()).describe("Distinct angles: primary sources, practitioner reports, criticism, recent changes, alternatives, local-language sources."),
      languages: z.array(z.string()),
      engines: z.array(z.enum(ENGINE_IDS)),
      seedQueries: z.array(z.string()).describe("Descriptive English (or approved-language) queries that describe the target page."),
    }),
  ),
  exaRuns: z.array(
    z.object({
      id: z.string(),
      segmentIds: z.array(z.string()).describe("Segments this run covers; empty means the whole question."),
      query: z.string().describe("Full task specification: scope, evidence required, what complete looks like."),
      systemPrompt: z.string().nullable(),
      effort: z.enum(["medium", "high", "xhigh", "auto", "ultra"]),
      budgetUsd: z.number().nullable().describe("Required for auto and ultra, null otherwise."),
      maxDurationSeconds: z.number().nullable().describe("Ultra only, 300-10800, else null."),
      outputSchemaJson: z.string().nullable().describe("JSON Schema as a string, or null for prose output."),
    }),
  ),
  notes: z.string().nullable(),
});

export type Plan = z.infer<typeof PlanSchema>;

const SEGMENT_RANGE: Record<Depth, [number, number]> = { standard: [1, 3], deep: [3, 6], exhaustive: [4, 10] };
const ALLOWED_EFFORTS: Record<Depth, readonly AgentEffortName[]> = {
  standard: ["medium"],
  deep: ["medium", "high"],
  exhaustive: AGENT_EFFORTS,
};
const MAX_EXA_RUNS: Record<Depth, number> = { standard: 2, deep: 6, exhaustive: 10 };
const BASE_LANGUAGES = ["en", "de"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PlanConstraints {
  depth: Depth;
  /** Languages the user approved beyond English and German. */
  extraLanguages: string[];
  maxExaUsd: number;
  allowUltra: boolean;
  availableEngines: EngineId[];
  exaAvailable: boolean;
}

export interface WorstCase {
  exaAgentUsd: number;
  exaSearchUsd: number;
  braveRequests: number;
  braveUsd: number;
  totalExaUsd: number;
}

export function computeWorstCase(plan: Plan, depth: Depth): WorstCase {
  const exaAgentUsd = plan.exaRuns.reduce((sum, r) => sum + agentWorstCase(r.effort, r.budgetUsd ?? undefined), 0);
  const exaSegments = plan.segments.filter((s) => s.engines.includes("exa")).length;
  const exaSearchUsd = exaSegments * estimateSegmentExaSpend(depth);
  const braveSegments = plan.segments.filter((s) => s.engines.includes("brave")).length;
  // Brave is not capped by the Exa budget; estimate with the same searches-per-segment figure.
  const braveRequests = braveSegments * (depth === "standard" ? 8 : depth === "deep" ? 15 : 25);
  return { exaAgentUsd, exaSearchUsd, braveRequests, braveUsd: braveRequests * 0.005, totalExaUsd: exaAgentUsd + exaSearchUsd };
}

export interface PlanCheck {
  errors: string[];
  worstCase: WorstCase;
}

export function validatePlan(plan: Plan, c: PlanConstraints): PlanCheck {
  const errors: string[] = [];
  const [minSeg, maxSeg] = SEGMENT_RANGE[c.depth];
  const allowedLangs = new Set([...BASE_LANGUAGES, ...c.extraLanguages.map((l) => l.toLowerCase())]);

  if (!plan.question.trim()) errors.push("question is empty");
  if (!plan.successCriteria.trim()) errors.push("successCriteria is empty");

  const { from, to } = plan.timeWindow;
  for (const [name, v] of [["from", from], ["to", to]] as const) {
    if (v !== null && (!DATE.test(v) || Number.isNaN(Date.parse(v)))) errors.push(`timeWindow.${name} must be YYYY-MM-DD or null, got "${v}"`);
  }
  if (from && to && DATE.test(from) && DATE.test(to) && from > to) errors.push("timeWindow.from is after timeWindow.to");

  const langs = plan.languages.map((l) => l.toLowerCase());
  if (!langs.includes("en")) errors.push('languages must include "en"');
  for (const l of langs) {
    if (!allowedLangs.has(l)) errors.push(`language "${l}" is not approved; only ${[...allowedLangs].join(", ")} are allowed (list others under notes as a suggestion)`);
  }

  if (plan.segments.length < minSeg || plan.segments.length > maxSeg) {
    errors.push(`depth ${c.depth} needs ${minSeg}-${maxSeg} segments, got ${plan.segments.length}`);
  }
  const segIds = new Set<string>();
  for (const s of plan.segments) {
    if (!SLUG.test(s.id)) errors.push(`segment id "${s.id}" must match ${SLUG}`);
    if (segIds.has(s.id)) errors.push(`duplicate segment id "${s.id}"`);
    segIds.add(s.id);
    if (!s.objective.trim()) errors.push(`segment ${s.id} has no objective`);
    if (s.angles.length === 0) errors.push(`segment ${s.id} needs at least one angle`);
    if (s.seedQueries.length === 0) errors.push(`segment ${s.id} needs at least one seed query`);
    if (s.languages.length === 0) errors.push(`segment ${s.id} needs at least one language`);
    for (const l of s.languages.map((x) => x.toLowerCase())) {
      if (!langs.includes(l)) errors.push(`segment ${s.id} uses language "${l}" that is not in the plan languages`);
    }
    if (s.engines.length === 0) errors.push(`segment ${s.id} needs at least one engine`);
    for (const e of s.engines) {
      if (!c.availableEngines.includes(e)) errors.push(`segment ${s.id} uses engine "${e}", which is not available (available: ${c.availableEngines.join(", ") || "none"})`);
    }
  }

  if (plan.exaRuns.length > MAX_EXA_RUNS[c.depth]) errors.push(`depth ${c.depth} allows at most ${MAX_EXA_RUNS[c.depth]} Exa Agent runs, got ${plan.exaRuns.length}`);
  if (plan.exaRuns.length > 0 && !c.exaAvailable) errors.push("Exa Agent runs were planned but Exa is not available; use no exaRuns");
  const runIds = new Set<string>();
  for (const r of plan.exaRuns) {
    if (!SLUG.test(r.id)) errors.push(`exaRun id "${r.id}" must match ${SLUG}`);
    if (runIds.has(r.id)) errors.push(`duplicate exaRun id "${r.id}"`);
    runIds.add(r.id);
    if (!r.query.trim()) errors.push(`exaRun ${r.id} has an empty query`);
    for (const sid of r.segmentIds) if (!segIds.has(sid)) errors.push(`exaRun ${r.id} references unknown segment "${sid}"`);
    if (!ALLOWED_EFFORTS[c.depth].includes(r.effort)) errors.push(`exaRun ${r.id}: effort ${r.effort} is not allowed at depth ${c.depth} (allowed: ${ALLOWED_EFFORTS[c.depth].join(", ")})`);
    if (r.effort === "ultra" && !c.allowUltra) errors.push(`exaRun ${r.id}: ultra was not requested; use xhigh or auto with a budget`);
    const metered = r.effort === "auto" || r.effort === "ultra";
    if (metered) {
      if (r.budgetUsd === null || r.budgetUsd < 1 || r.budgetUsd > 100) errors.push(`exaRun ${r.id}: ${r.effort} needs budgetUsd between 1 and 100`);
    } else if (r.budgetUsd !== null) errors.push(`exaRun ${r.id}: ${r.effort} is a fixed price; budgetUsd must be null`);
    if (r.maxDurationSeconds !== null) {
      if (r.effort !== "ultra") errors.push(`exaRun ${r.id}: maxDurationSeconds is only for ultra`);
      else if (r.maxDurationSeconds < 300 || r.maxDurationSeconds > 10_800) errors.push(`exaRun ${r.id}: maxDurationSeconds must be 300-10800`);
    }
    if (r.effort === "ultra" && r.maxDurationSeconds === null) errors.push(`exaRun ${r.id}: ultra needs maxDurationSeconds`);
    if (r.outputSchemaJson !== null) {
      try {
        const parsed = JSON.parse(r.outputSchemaJson);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) errors.push(`exaRun ${r.id}: outputSchemaJson must be a JSON object`);
      } catch {
        errors.push(`exaRun ${r.id}: outputSchemaJson is not valid JSON`);
      }
    }
  }

  const worstCase = computeWorstCase(plan, c.depth);
  if (worstCase.totalExaUsd > c.maxExaUsd + 1e-9) {
    errors.push(
      `worst-case Exa cost $${worstCase.totalExaUsd.toFixed(2)} exceeds the cap of $${c.maxExaUsd.toFixed(2)}; use fewer segments or Exa runs, or a lower effort`,
    );
  }
  return { errors, worstCase };
}

/** Human-readable plan for the approval step. */
export function formatPlan(plan: Plan, depth: Depth, wc: WorstCase, maxExaUsd: number): string {
  const lines = [
    `Question: ${plan.question}`,
    `Depth: ${depth}. Languages: ${plan.languages.join(", ")}. Window: ${plan.timeWindow.from ?? "open"} to ${plan.timeWindow.to ?? "open"}.`,
    `Done when: ${plan.successCriteria}`,
    "",
    `Segments (${plan.segments.length}):`,
  ];
  for (const s of plan.segments) {
    lines.push(`- ${s.id}: ${s.name} [${s.engines.join("+")}; ${s.languages.join(",")}]`, `    ${s.objective}`, `    angles: ${s.angles.join("; ")}`);
  }
  lines.push("", `Exa Agent runs (${plan.exaRuns.length}):`);
  if (plan.exaRuns.length === 0) lines.push("- none");
  for (const r of plan.exaRuns) {
    const budget = r.budgetUsd !== null ? `, cap $${r.budgetUsd}` : "";
    const dur = r.maxDurationSeconds !== null ? `, up to ${Math.round(r.maxDurationSeconds / 60)} min` : "";
    lines.push(`- ${r.id}: effort ${r.effort}${budget}${dur}, covers ${r.segmentIds.join(", ") || "whole question"}`);
  }
  lines.push(
    "",
    `Worst-case Exa cost: $${wc.totalExaUsd.toFixed(2)} (agent runs $${wc.exaAgentUsd.toFixed(2)} + searches and page reads ~$${wc.exaSearchUsd.toFixed(2)}), hard cap $${maxExaUsd.toFixed(2)}.`,
    `Brave: about ${wc.braveRequests} requests, ~$${wc.braveUsd.toFixed(2)} (outside the Exa cap).`,
    "Claude usage for planning and research comes from the configured auth (subscription or API key).",
  );
  if (plan.notes) lines.push("", `Notes: ${plan.notes}`);
  return lines.join("\n");
}
