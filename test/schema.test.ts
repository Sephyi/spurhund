import { describe, expect, it } from "vitest";
import { PlanSchema } from "../src/worker/plan.js";
import { MergeResultSchema, NarrativeSchema, jsonSchemaOf } from "../src/worker/prompts.js";

/**
 * Anthropic's structured outputs reject numeric and string constraints, `minItems` above 1,
 * `additionalProperties` other than false, and recursive schemas (platform docs, "JSON Schema limitations").
 * The planner, merge and report sessions send these schemas through the Agent SDK's `outputFormat`.
 */
const FORBIDDEN_KEYS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems", "minProperties", "maxProperties", "patternProperties", "if", "then", "else", "not", "oneOf"];
const ALLOWED_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

function violations(node: unknown, pathStr = "$", seenRefs: string[] = []): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => violations(n, `${pathStr}[${i}]`, seenRefs));
  if (node === null || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  const out: string[] = [];
  for (const k of FORBIDDEN_KEYS) if (k in o) out.push(`${pathStr}: unsupported keyword "${k}"`);
  if ("minItems" in o && ![0, 1].includes(o.minItems as number)) out.push(`${pathStr}: minItems must be 0 or 1`);
  if (o.type === "object" || "properties" in o) {
    if (o.additionalProperties !== false) out.push(`${pathStr}: object without additionalProperties:false`);
  } else if ("additionalProperties" in o && o.additionalProperties !== false) out.push(`${pathStr}: additionalProperties must be false`);
  if (typeof o.format === "string" && !ALLOWED_FORMATS.has(o.format)) out.push(`${pathStr}: format "${o.format}" not supported`);
  if (typeof o.pattern === "string" && /\\[bB]|\(\?[=!<]|\\\d/.test(o.pattern)) out.push(`${pathStr}: unsupported regex feature in pattern`);
  if (typeof o.$ref === "string") {
    if (!o.$ref.startsWith("#")) out.push(`${pathStr}: external $ref`);
    if (seenRefs.includes(o.$ref)) out.push(`${pathStr}: recursive $ref ${o.$ref}`);
  }
  for (const [k, v] of Object.entries(o)) out.push(...violations(v, `${pathStr}.${k}`, typeof o.$ref === "string" ? [...seenRefs, o.$ref] : seenRefs));
  return out;
}

/** Counts parameters that use anyOf or type arrays, and properties missing from `required`. */
function complexity(node: unknown): { unions: number; optional: number } {
  const total = { unions: 0, optional: 0 };
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n === null || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (Array.isArray(o.type) || Array.isArray(o.anyOf)) total.unions++;
    if (o.properties && typeof o.properties === "object") {
      const required = new Set((o.required as string[] | undefined) ?? []);
      total.optional += Object.keys(o.properties).filter((k) => !required.has(k)).length;
    }
    Object.values(o).forEach(walk);
  };
  walk(node);
  return total;
}

describe("structured-output schemas stay within Anthropic's documented limits", () => {
  for (const [name, schema] of [["PlanSchema", PlanSchema], ["MergeResultSchema", MergeResultSchema], ["NarrativeSchema", NarrativeSchema]] as const) {
    it(name, () => {
      const js = jsonSchemaOf(schema);
      expect(violations(js)).toEqual([]);
      expect(js.required).toBeDefined(); // every property is required; optional values are nullable
    });
  }

  it("keeps clear of the complexity limits (16 union-typed and 24 optional parameters per request)", () => {
    for (const schema of [PlanSchema, MergeResultSchema, NarrativeSchema]) {
      const c = complexity(jsonSchemaOf(schema));
      expect(c.unions).toBeLessThanOrEqual(12);
      expect(c.optional).toBe(0);
    }
    expect(complexity(jsonSchemaOf(PlanSchema)).unions).toBe(7); // from, to, systemPrompt, budgetUsd, maxDurationSeconds, outputSchemaJson, notes
  });

  it("the checker itself catches what it should", () => {
    expect(violations({ type: "object", properties: { a: { type: "string", maxLength: 5 } }, additionalProperties: false })).toEqual(['$.properties.a: unsupported keyword "maxLength"']);
    expect(violations({ type: "object", properties: {} })).toEqual(["$: object without additionalProperties:false"]);
    expect(violations({ type: "array", minItems: 3, items: {} })).toEqual(["$: minItems must be 0 or 1"]);
    expect(violations({ type: "string", format: "regex" })).toEqual(['$: format "regex" not supported']);
  });
});
