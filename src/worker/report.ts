import { hostnameOf } from "../canonical.js";
import type { Config } from "../config.js";
import type { FindingRow, GapRow, JobRow, PlanRow, SourceRow, Store, Verification } from "../db/store.js";
import type { MergeResult, Narrative } from "./prompts.js";
import type { Plan } from "./plan.js";

export interface ReportInput {
  job: JobRow;
  planRow: PlanRow;
  narrative?: Narrative;
  merge?: MergeResult;
  config: Pick<Config, "efforts">;
}

export interface ReportJson {
  jobId: string;
  state: string;
  question: string;
  depth: string;
  partial: boolean;
  partialReason: string | null;
  summary: string | null;
  findings: {
    id: number;
    segment: string;
    claim: string;
    verification: Verification;
    verificationNote: string | null;
    sourceKind: string;
    evidence: string;
    critical: boolean;
    engines: string[];
    publishedDate: string | null;
    sources: { url: string; title: string | null; readStatus: string }[];
  }[];
  counts: Record<Verification, number> & { total: number };
  coverage: { segmentId: string; name: string; level: string; findings: number; note: string }[];
  gaps: { segment: string; description: string }[];
  closedGaps: GapRow[];
  engines: { sourcesTotal: number; foundBy: Record<string, number>; singleEngineCited: Record<string, number> };
  exaRuns: { id: string; effort: string; status: string; stopReason: string | null; costUsd: number }[];
  costs: { exaUsd: number; exaByEndpoint: Record<string, number>; braveUsd: number; claudeEstimateUsd: number };
  settings: { authMode: string; models: Record<string, string>; efforts: Config["efforts"]; capUsd: number };
  startedAt: string | null;
  finishedAt: string | null;
}

const ORDER: Verification[] = ["verified", "single_source", "unchecked", "unverified", "contradicted"];

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;

export function buildReport(store: Store, input: ReportInput): { markdown: string; json: ReportJson } {
  const { job, planRow } = input;
  const plan = planRow.plan as Plan;
  const findings = store.listFindings(job.id);
  const gaps = store.listGaps(job.id);
  const runs = store.listExaRuns(job.id);
  const stats = store.jobStats(job.id);
  const enginesBySource = store.enginesBySource(job.id);

  const sourceCache = new Map<number, SourceRow>();
  const source = (id: number) => {
    let s = sourceCache.get(id);
    if (!s) {
      s = store.getSource(id)!;
      sourceCache.set(id, s);
    }
    return s;
  };
  const enginesOf = (f: FindingRow) => [...new Set(f.sourceIds.flatMap((id) => enginesBySource.get(id) ?? []))].sort();

  const counts = { total: findings.length, verified: 0, single_source: 0, unchecked: 0, unverified: 0, contradicted: 0 } as ReportJson["counts"];
  for (const f of findings) counts[f.verification]++;

  // Provenance: how many sources each engine found, and how many cited sources only one engine found.
  const foundBy: Record<string, number> = {};
  for (const engines of enginesBySource.values()) for (const e of engines) foundBy[e] = (foundBy[e] ?? 0) + 1;
  const cited = new Set(findings.flatMap((f) => f.sourceIds));
  const singleEngineCited: Record<string, number> = {};
  for (const id of cited) {
    const e = enginesBySource.get(id);
    if (e?.length === 1) singleEngineCited[e[0]!] = (singleEngineCited[e[0]!] ?? 0) + 1;
  }

  const levelBySegment = new Map((input.merge?.coverage ?? []).map((c) => [c.segmentId, c]));
  const coverage = plan.segments.map((s) => {
    const m = levelBySegment.get(s.id);
    return {
      segmentId: s.id,
      name: s.name,
      level: m?.level ?? "not assessed",
      findings: findings.filter((f) => f.segment === s.id).length,
      note: m?.note ?? "",
    };
  });

  const claudeEstimateUsd = job.claudeCostUsd;
  const exaByEndpoint = store.costByEndpoint(job.id, "exa");
  const partial = job.state !== "completed" || runs.some((r) => r.stopReason === "budget_reached" || r.stopReason === "time_limit_reached");
  const partialReason =
    job.state === "canceled" ? "the job was canceled"
    : job.state === "failed" ? `the job failed: ${job.error ?? "unknown error"}`
    : job.state !== "completed" ? `the job is still ${job.state}`
    : runs.some((r) => r.stopReason === "budget_reached" || r.stopReason === "time_limit_reached") ? "an Exa Agent run stopped at its budget or time limit"
    : null;

  const json: ReportJson = {
    jobId: job.id,
    state: job.state,
    question: plan.question,
    depth: planRow.depth,
    partial,
    partialReason,
    summary: input.narrative?.summary ?? null,
    findings: findings.map((f) => ({
      id: f.id,
      segment: f.segment,
      claim: f.claim,
      verification: f.verification,
      verificationNote: f.verificationNote,
      sourceKind: f.sourceKind,
      evidence: f.evidence,
      critical: f.critical,
      engines: enginesOf(f),
      publishedDate: f.publishedDate,
      sources: f.sourceIds.map((id) => ({ url: source(id).url, title: source(id).title, readStatus: source(id).readStatus })),
    })),
    counts,
    coverage,
    gaps: gaps.filter((g) => g.resolvedNote === null),
    closedGaps: gaps.filter((g) => g.resolvedNote !== null),
    engines: { sourcesTotal: enginesBySource.size, foundBy, singleEngineCited },
    exaRuns: runs.map((r) => ({ id: r.planRunId, effort: r.effort, status: r.status, stopReason: r.stopReason, costUsd: r.costUsd })),
    costs: { exaUsd: stats.exaCostUsd, exaByEndpoint, braveUsd: stats.braveCostUsd, claudeEstimateUsd },
    settings: { authMode: job.authMode, models: job.models, efforts: input.config.efforts, capUsd: job.maxExaUsd },
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };

  return { markdown: renderMarkdown(json, plan), json };
}

function renderMarkdown(r: ReportJson, plan: Plan): string {
  const L: string[] = [];
  L.push(`# Research report: ${r.question}`, "");
  L.push(`Job \`${r.jobId}\` · ${r.state} · depth ${r.depth} · ${r.startedAt ?? "not started"} to ${r.finishedAt ?? "running"}`, "");
  L.push(
    r.partial
      ? `> **Partial result:** ${r.partialReason}. Treat what follows as what was found so far, not as the full picture.`
      : "> Best-effort result. Coverage is limited by the sources, engines and budget below; the gaps section lists what stays open.",
    "",
  );

  L.push("## Summary", "");
  L.push(r.summary ?? "_No summary was generated. The findings below are the result._", "");

  L.push("## Verification status", "");
  L.push(`${r.counts.total} findings: ${ORDER.map((v) => `${r.counts[v]} ${v.replace("_", " ")}`).join(", ")}.`, "");

  L.push("## Findings", "");
  const segName = new Map(plan.segments.map((s) => [s.id, s.name]));
  const segments = [...new Set(r.findings.map((f) => f.segment))];
  for (const seg of segments) {
    L.push(`### ${segName.get(seg) ?? seg}`, "");
    const list = r.findings.filter((f) => f.segment === seg).sort((a, b) => ORDER.indexOf(a.verification) - ORDER.indexOf(b.verification) || a.id - b.id);
    for (const f of list) {
      const flags = [
        f.verification.replace("_", " "),
        f.critical ? "critical" : undefined,
        f.sourceKind,
        f.evidence === "fetched" ? "page read" : "snippet only",
        f.engines.length ? `found by ${f.engines.join("+")}` : undefined,
        f.publishedDate ?? undefined,
      ].filter(Boolean);
      L.push(`- **#${f.id}** ${f.claim}`, `  _${flags.join(" · ")}_`);
      L.push(`  Sources: ${f.sources.map((s) => `[${hostnameOf(s.url) ?? s.url}](${s.url})${s.readStatus === "read" ? "" : ` (${s.readStatus})`}`).join(", ")}`);
      if (f.verificationNote) L.push(`  Check: ${f.verificationNote}`);
    }
    L.push("");
  }
  if (!r.findings.length) L.push("_No findings were recorded._", "");

  L.push("## Coverage (assessed at merge, before verification)", "", "| Segment | Assessment | Findings | Note |", "| --- | --- | --- | --- |");
  for (const c of r.coverage) L.push(`| ${c.name} | ${c.level} | ${c.findings} | ${c.note.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  L.push("");

  L.push("## Open gaps", "");
  if (r.gaps.length) L.push(...r.gaps.map((g) => `- (${g.segment}) ${g.description}`));
  else L.push("- None were recorded. That reflects what the research looked for, not proof that nothing is missing.");
  L.push("");

  L.push("## Closed gaps", "");
  if (r.closedGaps.length) L.push(...r.closedGaps.map((g) => `- #${g.id} (${g.segment}) ${g.description}. ${g.resolvedNote} Findings: ${g.resolvedBy.map((id) => `[#${id}]`).join(", ")}.`));
  else L.push("- None.");
  L.push("");

  L.push("## Engines", "");
  const fb = Object.entries(r.engines.foundBy).map(([e, n]) => `${e} ${n}`).join(", ") || "none";
  L.push(`${r.engines.sourcesTotal} distinct sources surfaced (${fb}).`);
  const single = Object.entries(r.engines.singleEngineCited);
  L.push(
    single.length
      ? `Cited sources found by only one engine: ${single.map(([e, n]) => `${e} ${n}`).join(", ")}. A direction with many single-engine sources is where coverage is thinnest.`
      : "No cited source was found by only one engine.",
    "",
  );

  L.push("## Exa Agent runs", "");
  if (r.exaRuns.length) {
    L.push("| Run | Effort | Status | Stop reason | Cost |", "| --- | --- | --- | --- | --- |");
    for (const x of r.exaRuns) L.push(`| ${x.id} | ${x.effort} | ${x.status} | ${x.stopReason ?? ""} | ${usd(x.costUsd)} |`);
  } else L.push("None.");
  L.push("");

  L.push("## Costs and settings", "");
  const ep = Object.entries(r.costs.exaByEndpoint).map(([e, v]) => `${e} ${usd(v)}`).join(", ");
  L.push(
    `- Exa: ${usd(r.costs.exaUsd)}${ep ? ` (${ep})` : ""} of a ${usd(r.settings.capUsd)} cap.`,
    `- Brave: ${usd(r.costs.braveUsd)}.`,
    `- Claude: about ${usd(r.costs.claudeEstimateUsd)} by the SDK's client-side estimate (${r.settings.authMode === "oauth" ? "subscription usage, not a bill" : "billed per token to the API key"}).`,
    `- Auth: ${r.settings.authMode}. Models: ${Object.entries(r.settings.models).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `- Claude effort: ${Object.entries(r.settings.efforts).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    "",
  );
  return L.join("\n");
}
