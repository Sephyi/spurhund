import { describe, expect, it } from "vitest";
import { PlanSchema, computeWorstCase, formatPlan, validatePlan, type Plan, type PlanConstraints } from "../src/worker/plan.js";
import { jsonSchemaOf, MergeResultSchema, NarrativeSchema } from "../src/worker/prompts.js";

const segment = (id: string, over: Partial<Plan["segments"][number]> = {}): Plan["segments"][number] => ({
  id,
  name: `Segment ${id}`,
  objective: `Find out about ${id}`,
  angles: ["primary sources", "criticism"],
  languages: ["en"],
  engines: ["exa", "brave"],
  seedQueries: [`official documentation for ${id}`],
  ...over,
});

const run = (id: string, over: Partial<Plan["exaRuns"][number]> = {}): Plan["exaRuns"][number] => ({
  id,
  segmentIds: [],
  query: "Find every X that meets Y",
  systemPrompt: null,
  effort: "medium",
  budgetUsd: null,
  maxDurationSeconds: null,
  outputSchemaJson: null,
  ...over,
});

const plan = (over: Partial<Plan> = {}): Plan => ({
  question: "How do TLS libraries ship ML-KEM?",
  successCriteria: "A list of libraries with release status and sources",
  timeWindow: { from: "2026-01-01", to: null },
  languages: ["en"],
  segments: [segment("openssl")],
  exaRuns: [],
  notes: null,
  ...over,
});

const constraints = (over: Partial<PlanConstraints> = {}): PlanConstraints => ({
  depth: "standard",
  extraLanguages: [],
  maxExaUsd: 5,
  allowUltra: false,
  availableEngines: ["exa", "brave"],
  exaAvailable: true,
  ...over,
});

describe("validatePlan", () => {
  it("accepts a minimal valid standard plan", () => {
    const r = validatePlan(plan(), constraints());
    expect(r.errors).toEqual([]);
    expect(r.worstCase.exaAgentUsd).toBe(0);
    expect(r.worstCase.totalExaUsd).toBeGreaterThan(0);
  });

  it("enforces the segment range per depth", () => {
    expect(validatePlan(plan({ segments: [] }), constraints()).errors.join()).toMatch(/needs 1-3 segments, got 0/);
    expect(validatePlan(plan({ segments: ["a", "b", "c", "d"].map((i) => segment(i)) }), constraints()).errors.join()).toMatch(/1-3 segments, got 4/);
    expect(validatePlan(plan({ segments: [segment("a"), segment("b")] }), constraints({ depth: "deep" })).errors.join()).toMatch(/3-6 segments, got 2/);
    const ten = Array.from({ length: 10 }, (_, i) => segment(`s${i}`));
    expect(validatePlan(plan({ segments: ten }), constraints({ depth: "exhaustive", maxExaUsd: 50 })).errors).toEqual([]);
  });

  it("only allows English, German and explicitly approved languages", () => {
    const withFr = plan({ languages: ["en", "fr"], segments: [segment("a", { languages: ["en", "fr"] })] });
    expect(validatePlan(withFr, constraints()).errors.join()).toMatch(/language "fr" is not approved/);
    expect(validatePlan(withFr, constraints({ extraLanguages: ["fr"] })).errors).toEqual([]);
    expect(validatePlan(plan({ languages: ["de"] }), constraints()).errors.join()).toMatch(/must include "en"/);
    expect(validatePlan(plan({ languages: ["en", "DE"], segments: [segment("a", { languages: ["de"] })] }), constraints()).errors).toEqual([]);
    expect(validatePlan(plan({ segments: [segment("a", { languages: ["de"] })] }), constraints()).errors.join()).toMatch(/not in the plan languages/);
  });

  it("rejects unavailable engines, bad slugs and duplicates", () => {
    const errs = validatePlan(
      plan({ segments: [segment("Bad Slug"), segment("dup"), segment("dup", { engines: ["brave"] })] }),
      constraints({ availableEngines: ["exa"] }),
    ).errors.join("\n");
    expect(errs).toMatch(/segment id "Bad Slug" must match/);
    expect(errs).toMatch(/duplicate segment id "dup"/);
    expect(errs).toMatch(/uses engine "brave", which is not available/);
  });

  it("validates the time window", () => {
    expect(validatePlan(plan({ timeWindow: { from: "2026-13-45", to: null } }), constraints()).errors.join()).toMatch(/timeWindow.from/);
    expect(validatePlan(plan({ timeWindow: { from: "2026-06-01", to: "2026-01-01" } }), constraints()).errors.join()).toMatch(/after/);
    expect(validatePlan(plan({ timeWindow: { from: null, to: null } }), constraints()).errors).toEqual([]);
  });

  describe("Exa Agent runs", () => {
    it("sets effort rules by depth", () => {
      expect(validatePlan(plan({ exaRuns: [run("r", { effort: "high" })] }), constraints()).errors.join()).toMatch(/effort high is not allowed at depth standard/);
      const deep = plan({ segments: ["a", "b", "c"].map((i) => segment(i)), exaRuns: [run("r", { effort: "high" })] });
      expect(validatePlan(deep, constraints({ depth: "deep" })).errors).toEqual([]);
    });

    it("requires budgets for metered efforts and forbids them for fixed ones", () => {
      const base = { segments: ["a", "b", "c", "d"].map((i) => segment(i)) };
      const c = constraints({ depth: "exhaustive", maxExaUsd: 50 });
      expect(validatePlan(plan({ ...base, exaRuns: [run("r", { effort: "auto" })] }), c).errors.join()).toMatch(/auto needs budgetUsd between 1 and 100/);
      expect(validatePlan(plan({ ...base, exaRuns: [run("r", { effort: "auto", budgetUsd: 0.5 })] }), c).errors.join()).toMatch(/between 1 and 100/);
      expect(validatePlan(plan({ ...base, exaRuns: [run("r", { effort: "auto", budgetUsd: 4 })] }), c).errors).toEqual([]);
      expect(validatePlan(plan({ ...base, exaRuns: [run("r", { effort: "xhigh", budgetUsd: 4 })] }), c).errors.join()).toMatch(/fixed price/);
    });

    it("gates ultra behind the explicit flag and requires a duration", () => {
      const base = { segments: ["a", "b", "c", "d"].map((i) => segment(i)) };
      const ultra = (over = {}) => plan({ ...base, exaRuns: [run("r", { effort: "ultra", budgetUsd: 10, maxDurationSeconds: 1800, ...over })] });
      const c = constraints({ depth: "exhaustive", maxExaUsd: 50 });
      expect(validatePlan(ultra(), c).errors.join()).toMatch(/ultra was not requested/);
      expect(validatePlan(ultra(), { ...c, allowUltra: true }).errors).toEqual([]);
      expect(validatePlan(ultra({ maxDurationSeconds: null }), { ...c, allowUltra: true }).errors.join()).toMatch(/ultra needs maxDurationSeconds/);
      expect(validatePlan(ultra({ maxDurationSeconds: 60 }), { ...c, allowUltra: true }).errors.join()).toMatch(/300-10800/);
      expect(validatePlan(plan({ ...base, exaRuns: [run("r", { effort: "high", maxDurationSeconds: 600 })] }), c).errors.join()).toMatch(/only for ultra/);
    });

    it("rejects unknown segments, invalid schemas and missing Exa", () => {
      const errs = validatePlan(
        plan({ exaRuns: [run("r", { segmentIds: ["nope"], outputSchemaJson: "{not json" }), run("q", { outputSchemaJson: "[1]" })] }),
        constraints(),
      ).errors.join("\n");
      expect(errs).toMatch(/unknown segment "nope"/);
      expect(errs).toMatch(/exaRun r: outputSchemaJson is not valid JSON/);
      expect(errs).toMatch(/exaRun q: outputSchemaJson must be a JSON object/);
      expect(validatePlan(plan({ exaRuns: [run("r")] }), constraints({ exaAvailable: false })).errors.join()).toMatch(/Exa is not available/);
    });

    it("caps the number of runs per depth", () => {
      const runs = ["a", "b", "c"].map((id) => run(id));
      expect(validatePlan(plan({ exaRuns: runs }), constraints()).errors.join()).toMatch(/at most 2 Exa Agent runs/);
    });
  });

  it("rejects plans whose worst case exceeds the cap and explains the numbers", () => {
    const p = plan({ segments: ["a", "b", "c", "d"].map((i) => segment(i)), exaRuns: [run("r", { effort: "xhigh" }), run("s", { effort: "xhigh" })] });
    const r = validatePlan(p, constraints({ depth: "exhaustive", maxExaUsd: 2 }));
    expect(r.errors.join()).toMatch(/worst-case Exa cost \$\d+\.\d\d exceeds the cap of \$2\.00/);
  });
});

describe("computeWorstCase", () => {
  it("adds agent runs at their ceiling and search allowances per Exa segment only", () => {
    const p = plan({
      segments: [segment("a"), segment("b", { engines: ["brave"] })],
      exaRuns: [run("r1", { effort: "high" }), run("r2", { effort: "auto", budgetUsd: 3 })],
    });
    const wc = computeWorstCase(p, "deep");
    expect(wc.exaAgentUsd).toBeCloseTo(3.5);
    expect(wc.exaSearchUsd).toBeCloseTo(15 * 0.007 + 25 * 0.001);
    expect(wc.braveRequests).toBe(30);
    expect(wc.totalExaUsd).toBeCloseTo(wc.exaAgentUsd + wc.exaSearchUsd);
  });
});

describe("formatPlan", () => {
  it("shows segments, runs, languages and the worst-case cost against the cap", () => {
    const p = plan({ exaRuns: [run("r1", { effort: "auto", budgetUsd: 3, segmentIds: ["openssl"] })], notes: "check FIPS 203 status" });
    const wc = computeWorstCase(p, "standard");
    const text = formatPlan(p, "standard", wc, 5);
    expect(text).toContain("Segments (1):");
    expect(text).toContain("openssl");
    expect(text).toContain("r1: effort auto, cap $3");
    expect(text).toMatch(/Worst-case Exa cost: \$\d+\.\d\d .* hard cap \$5\.00/);
    expect(text).toContain("Notes: check FIPS 203 status");
  });
});

describe("JSON schemas for structured output", () => {
  it("convert without $schema and carry the planner's field set", () => {
    for (const s of [PlanSchema, MergeResultSchema, NarrativeSchema]) {
      const js = jsonSchemaOf(s);
      expect(js).not.toHaveProperty("$schema");
      expect(js.type).toBe("object");
    }
    const props = (jsonSchemaOf(PlanSchema).properties as Record<string, unknown>);
    expect(Object.keys(props)).toEqual(["question", "successCriteria", "timeWindow", "languages", "segments", "exaRuns", "notes"]);
  });
});
