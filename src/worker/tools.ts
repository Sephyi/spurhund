import { z } from "zod";
import { hostnameOf } from "../canonical.js";
import type { Core } from "../core.js";
import type { FindingRow, SourceRow, Store, Verification } from "../db/store.js";
import { ENGINE_IDS, type EngineId } from "../config.js";
import { formatFetch, formatSearch } from "../mcp/format.js";
import { clip, errorMessage } from "../util.js";

export interface ToolOutput {
  text: string;
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  handler: (args: Record<string, unknown>) => Promise<ToolOutput>;
}

export type Role = "planner" | "segment" | "merge" | "gap" | "verify" | "report";

export interface ToolContext {
  core: Core;
  store: Store;
  jobId?: string;
  /** Segment label findings are recorded under (fixed per session, never chosen by the model). */
  segment?: string;
  /** Engines the approved plan assigned to this segment; the model cannot widen them. */
  engines?: EngineId[];
}

const MAX_FINDING_SOURCES = 6;
const LIST_PAGE = 60;

function define<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  readOnly: boolean,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolOutput>,
): ToolSpec {
  const schema = z.object(shape);
  return {
    name,
    description,
    shape,
    readOnly,
    handler: async (raw) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { isError: true, text: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}` };
      try {
        return await handler(parsed.data);
      } catch (err) {
        return { isError: true, text: errorMessage(err) };
      }
    },
  };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function engineLabel(engines: string[] | undefined): string {
  return engines?.length ? [...engines].sort().join("+") : "none";
}

function describeFinding(f: FindingRow, engines: Map<number, string[]>, sources: Map<number, SourceRow>, jobFetched: (id: number) => boolean): string {
  const eng = engineLabel([...new Set(f.sourceIds.flatMap((id) => engines.get(id) ?? []))]);
  const flags = [f.sourceKind, f.evidence, `engines: ${eng}`, f.critical ? "CRITICAL" : undefined, `verification: ${f.verification}`]
    .filter(Boolean)
    .join(", ");
  const urls = f.sourceIds.map((id) => {
    const s = sources.get(id);
    if (!s) return `source#${id}`;
    // Show the state as this job sees it, so the verifier fetches what it has not read itself.
    const state = s.readStatus === "unread" || s.readStatus === "not_read" || jobFetched(id) ? s.readStatus : "unread";
    return `${s.url} [${state}]`;
  });
  return `#${f.id} [${f.segment}] (${flags}) ${f.claim}\n    sources: ${urls.join(" | ")}${f.verificationNote ? `\n    note: ${f.verificationNote}` : ""}`;
}

export function buildToolset(role: Role, ctx: ToolContext): ToolSpec[] {
  const { core, store } = ctx;
  const jobId = ctx.jobId;

  const search = define(
    "search",
    "Search the configured engines in parallel (Exa and Brave) and get one merged, deduplicated list with the engine that found each result. " +
      "Describe the page you want in a full phrase. Results are leads, not facts: read pages with `fetch` before relying on them.",
    {
      query: z.string().min(1).max(2000),
      objective: z.string().max(4096).optional().describe("Goal of this search: what should rank first, what to exclude, what to pull."),
      num_results: z.number().int().min(1).max(25).default(10),
      engines: z.array(z.enum(ENGINE_IDS)).optional(),
      country: z.string().length(2).optional(),
      lang: z.string().min(2).max(5).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
    },
    true,
    async (a) => {
      // The plan's engine choice per segment is binding (it is what the approved cost estimate assumed).
      const engines = ctx.engines?.length ? (a.engines?.length ? a.engines.filter((e) => ctx.engines!.includes(e)) : ctx.engines) : a.engines;
      if (engines && engines.length === 0) return { isError: true, text: `This segment is limited to: ${ctx.engines!.join(", ")}.` };
      const out = await core.search({ query: a.query, objective: a.objective, numResults: a.num_results, engines, country: a.country, lang: a.lang, from: a.from, to: a.to });
      return { text: formatSearch(out) };
    },
  );

  const fetch = define(
    "fetch",
    "Read up to 10 pages. Each is READ, TRUNCATED or NOT_READ. NOT_READ pages (empty, script shell, wall, error) must not be cited as read. " +
      "Pages you already read are served from cache; do not fetch the same URL again.",
    {
      urls: z.array(z.string().url()).min(1).max(10),
      max_characters: z.number().int().min(1000).max(60_000).default(12_000),
    },
    true,
    async (a) => ({ text: formatFetch(await core.fetch({ urls: a.urls, maxCharacters: a.max_characters })) }),
  );

  const recordFinding = define(
    "record_finding",
    "Record one finding: a single checkable claim with the URLs that support it. Every URL must have come from a search or fetch in this job. " +
      "Whether the evidence was fetched is computed from what was actually read, not from what you say.",
    {
      claim: z.string().min(10).max(1200).describe("One self-contained, checkable statement with names, versions and dates."),
      sources: z.array(z.string().url()).min(1).max(MAX_FINDING_SOURCES),
      source_kind: z.enum(["primary", "secondary"]).describe("primary: the originating organization, upstream code, original research or reporting."),
      published_date: isoDate.optional().describe("Publication date of the best source, if known."),
      critical: z.boolean().default(false).describe("True if a decision rests on this claim (exposure status, a figure, a legal point)."),
    },
    false,
    async (a) => {
      if (!jobId) return { isError: true, text: "Findings belong to a job." };
      const unknown = a.sources.filter((u) => {
        const s = store.getSourceByUrl(u);
        return !s || !core.jobHasSeen(s.id);
      });
      if (unknown.length) {
        return { isError: true, text: `These URLs were never returned by a search or fetch in this job: ${unknown.join(", ")}. Search or fetch them first; never cite from memory.` };
      }
      const sourceIds = core.resolveSources(a.sources);
      // Read in this job, not merely somewhere earlier: the global cache state does not count.
      const readFully = sourceIds.some((id) => store.jobHasFetched(jobId, id) && store.getSource(id)?.readStatus === "read");
      const id = store.addFinding({
        jobId,
        segment: ctx.segment ?? "general",
        claim: a.claim,
        sourceIds,
        sourceKind: a.source_kind,
        evidence: readFully ? "fetched" : "snippet",
        publishedDate: a.published_date,
        critical: a.critical,
      });
      const engines = engineLabel([...new Set(sourceIds.flatMap((s) => store.enginesBySource(jobId).get(s) ?? []))]);
      return { text: `Recorded finding #${id} (evidence: ${readFully ? "fetched" : "snippet only"}; found by: ${engines}).` };
    },
  );

  const recordGap = define(
    "record_gap",
    "Record something you could not find or verify, and what is missing (period, region, entity type, language). Honest gaps are part of the result.",
    { description: z.string().min(5).max(600) },
    false,
    async (a) => {
      if (!jobId) return { isError: true, text: "Gaps belong to a job." };
      store.addGap(jobId, ctx.segment ?? "general", a.description);
      return { text: "Gap recorded." };
    },
  );

  const listFindings = define(
    "list_findings",
    "List recorded findings of this job with their sources, evidence, engines and verification status.",
    {
      segment: z.string().optional(),
      only_unverified: z.boolean().default(false),
      offset: z.number().int().min(0).default(0),
    },
    true,
    async (a) => {
      if (!jobId) return { isError: true, text: "No job." };
      let all = store.listFindings(jobId);
      if (a.segment) all = all.filter((f) => f.segment === a.segment);
      if (a.only_unverified) all = all.filter((f) => f.verification === "unchecked");
      // With only_unverified the list shrinks as findings get checked, so an offset would skip some.
      const offset = a.only_unverified ? 0 : a.offset;
      const page = all.slice(offset, offset + LIST_PAGE);
      const engines = store.enginesBySource(jobId);
      const sources = new Map<number, SourceRow>();
      for (const f of page) for (const id of f.sourceIds) if (!sources.has(id)) sources.set(id, store.getSource(id)!);
      const more = offset + page.length < all.length;
      const head = a.only_unverified
        ? `${all.length} finding(s) still unchecked; showing the first ${page.length}.${more ? " Check these, then call list_findings again with only_unverified=true for the next ones." : ""}`
        : `${all.length} finding(s); showing ${offset + 1}-${offset + page.length}.${more ? ` Next page: offset ${offset + page.length}.` : ""}`;
      return { text: [head, ...page.map((f) => describeFinding(f, engines, sources, (id) => store.jobHasFetched(jobId, id)))].join("\n") };
    },
  );

  const mergeFindings = define(
    "merge_findings",
    "Fold duplicate findings (same claim, reworded or from another engine) into one. Sources are combined; criticality is kept.",
    { keep_id: z.number().int(), merge_ids: z.array(z.number().int()).min(1).max(20) },
    false,
    async (a) => {
      store.mergeFindings(a.keep_id, a.merge_ids, jobId);
      return { text: `Merged ${a.merge_ids.length} finding(s) into #${a.keep_id}.` };
    },
  );

  const setVerification = define(
    "set_verification",
    "Set a finding's verification status after checking it. `verified` needs at least one cited page that was read in full; a CRITICAL finding needs two independent hosts. " +
      "Use single_source when only one source supports it, unverified when you could not check it, contradicted when a better source disagrees.",
    {
      finding_id: z.number().int(),
      status: z.enum(["verified", "single_source", "unverified", "contradicted"]),
      note: z.string().max(600).describe("What you checked, and which source settled it."),
      extra_sources: z.array(z.string().url()).max(4).default([]).describe("Independent sources you found while checking; they are added to the finding."),
    },
    false,
    async (a) => {
      const f = store.getFinding(a.finding_id);
      if (!f || (jobId && f.jobId !== jobId)) return { isError: true, text: `Finding #${a.finding_id} not found in this job.` };
      const unknown = a.extra_sources.filter((u) => {
        const s = store.getSourceByUrl(u);
        return !s || !core.jobHasSeen(s.id);
      });
      if (unknown.length) return { isError: true, text: `These URLs were never returned by a search or fetch in this job: ${unknown.join(", ")}.` };
      const sourceIds = [...new Set([...f.sourceIds, ...core.resolveSources(a.extra_sources)])];
      if (sourceIds.length !== f.sourceIds.length) store.setSourceIds(f.id, sourceIds);

      // Only pages this job actually read count as evidence for "verified".
      const rows = sourceIds.filter((id) => (jobId ? store.jobHasFetched(jobId, id) : false)).map((id) => store.getSource(id)!);
      let status: Verification = a.status;
      let note = a.note;
      if (status === "verified") {
        const readFully = rows.some((s) => s.readStatus === "read");
        const hosts = new Set(rows.filter((s) => s.readStatus === "read" || s.readStatus === "truncated").map((s) => hostnameOf(s.url)).filter(Boolean));
        if (!readFully) {
          status = "unverified";
          note = `Downgraded: no cited page was read in full. ${note}`;
        } else if (f.critical && hosts.size < 2) {
          status = "single_source";
          note = `Downgraded: a critical claim needs two independent hosts that were read, found ${hosts.size}. ${note}`;
        }
      }
      store.setVerification(f.id, status, note);
      store.refreshEvidence(f.jobId, f.id);
      return status === a.status
        ? { text: `Finding #${f.id} set to ${status}.` }
        : { text: `Finding #${f.id} set to ${status} instead of ${a.status}: ${note}` };
    },
  );

  const exaRunOutput = define(
    "exa_run_output",
    "Read the result of a completed Exa Agent run from the plan (text and structured output). Its cited pages are registered as seen, so you can cite them in record_finding.",
    { run_id: z.string() },
    true,
    async (a) => {
      if (!jobId) return { isError: true, text: "No job." };
      const run = store.listExaRuns(jobId).find((r) => r.planRunId === a.run_id);
      if (!run) return { isError: true, text: `No Exa run "${a.run_id}" in this job.` };
      const out = run.output as { text?: string | null; structured?: unknown; grounding?: unknown } | null;
      // Register the pages the run cited, so findings can cite them.
      const cited = new Set<string>();
      if (Array.isArray(out?.grounding)) {
        for (const entry of out.grounding as { citations?: { url?: string }[] }[]) {
          for (const c of entry.citations ?? []) if (typeof c.url === "string" && /^https?:\/\//i.test(c.url)) cited.add(c.url);
        }
      }
      for (const sourceId of core.resolveSources([...cited])) store.addHit({ sourceId, jobId, engine: "exa-agent", rank: 0, query: run.planRunId });
      const body = out ? JSON.stringify({ text: out.text, structured: out.structured, grounding: out.grounding }, null, 1) : "(no output)";
      return { text: `Exa run ${run.planRunId}: ${run.status}${run.stopReason ? ` (${run.stopReason})` : ""}, cost $${run.costUsd.toFixed(3)}\n${clip(body, 40_000)}` };
    },
  );

  switch (role) {
    case "planner":
      // Search only: the planner has no job, so a fetch would not be limited to seen URLs.
      return [search];
    case "segment":
      return [search, fetch, recordFinding, recordGap];
    case "merge":
      return [listFindings, exaRunOutput, recordFinding, mergeFindings, recordGap];
    case "gap":
      return [search, fetch, listFindings, recordFinding, recordGap];
    case "verify":
      return [listFindings, fetch, search, setVerification, recordGap];
    case "report":
      return [listFindings];
  }
}
