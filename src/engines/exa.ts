import { Exa } from "exa-js";
import { canonicalUrl } from "../canonical.js";
import { AGENT_EFFORTS, PRICES, agentWorstCase, type AgentEffortName } from "../costs.js";
import type { EngineResult } from "../merge.js";
import { randomUUID } from "node:crypto";
import { EngineError, Limiter, TimeoutError, errorMessage, isRetryable, withRetry, withTimeout, type RetryOptions } from "../util.js";
import type { Engine, EngineSearchOutput, FetchOutput, FetchedPage, SearchQuery } from "./types.js";

/** The slice of exa-js this project uses; tests inject a fake. */
export interface ExaClientLike {
  search(query: string, options: Record<string, unknown>): Promise<ExaResponseLike>;
  getContents(urls: string[], options: Record<string, unknown>): Promise<ExaResponseLike>;
  agent: {
    runs: {
      create(params: Record<string, unknown>): Promise<AgentRunLike>;
      get(runId: string): Promise<AgentRunLike>;
      stop(runId: string): Promise<AgentRunLike>;
      cancel(runId: string): Promise<AgentRunLike>;
      list(params?: { limit?: number; cursor?: string }): Promise<{ data: AgentRunLike[] }>;
    };
  };
}

export interface ExaResponseLike {
  results: {
    /** For contents requests Exa sets this to the URL that was asked for; `url` may be the redirect target. */
    id?: string;
    url: string;
    title?: string | null;
    publishedDate?: string;
    highlights?: string[];
    text?: string;
  }[];
  statuses?: { id: string; status: string; error?: { tag?: string; httpStatusCode?: number | null } | null }[];
  costDollars?: { total?: number };
}

export interface AgentRunLike {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  stopReason?: string | null;
  output?: { text?: string | null; structured?: unknown; grounding?: unknown } | null;
  costDollars?: { total?: number };
  error?: { message?: string; code?: string };
  metadata?: Record<string, unknown> | null;
  request?: Record<string, unknown>;
}

export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;
export const isTerminalRun = (r: AgentRunLike) => (TERMINAL_RUN_STATUSES as readonly string[]).includes(r.status);

export interface AgentRunRequest {
  query: string;
  systemPrompt?: string;
  effort: AgentEffortName;
  budgetUsd?: number;
  maxDurationSeconds?: number;
  outputSchema?: Record<string, unknown>;
  previousRunId?: string;
  exclusion?: Record<string, unknown>[];
}

const WALL_PATTERN =
  /(enable javascript|javascript is (required|disabled)|please enable cookies|verify you are (a )?human|access denied|just a moment\.\.\.|checking your browser)/i;

/**
 * Per-call timeout. The published exa-js 2.25.0 has no timeout or AbortSignal option
 * (they exist only in unreleased commits), so calls are raced against a timer: the
 * socket may linger, but the caller, the limiter slot and the pipeline move on.
 */
export const EXA_TIMEOUT_MS = 90_000;

export function exaFromKey(apiKey: string): ExaClientLike {
  return new Exa(apiKey) as unknown as ExaClientLike;
}

/**
 * A create request whose outcome is unknown (timeout, 5xx, network error):
 * Exa may or may not have started the run.
 */
export class AmbiguousCreateError extends Error {
  constructor(
    message: string,
    public readonly nonce: string,
  ) {
    super(message);
    this.name = "AmbiguousCreateError";
  }
}

/**
 * Classifies fetched text. Empty pages, script shells and walls count as not
 * read; text that fills the requested limit is flagged truncated.
 */
export function classifyPage(text: string | undefined | null, maxCharacters: number): Pick<FetchedPage, "status" | "reason" | "text"> {
  const raw = text ?? "";
  const t = raw.trim();
  if (t.length < 200) {
    return { status: "not_read", reason: t.length === 0 ? "empty page" : "page has almost no text (script shell or wall)", text: t || null };
  }
  if (t.length < 1500 && WALL_PATTERN.test(t)) return { status: "not_read", reason: "cookie, login or bot wall", text: t };
  // Compare the untrimmed length: Exa cuts at maxCharacters before whitespace is stripped.
  if (raw.length >= maxCharacters) return { status: "truncated", text: t };
  return { status: "read", text: t };
}

export class ExaEngine implements Engine {
  readonly id = "exa" as const;

  constructor(
    private readonly client: ExaClientLike,
    private readonly opts: { limiter?: Limiter; retry?: RetryOptions; timeoutMs?: number } = {},
  ) {}

  /** Idempotent calls: bounded by a timeout, retried on 429, 5xx and network errors. */
  private call<T>(fn: () => Promise<T>): Promise<T> {
    const timeoutMs = this.opts.timeoutMs ?? EXA_TIMEOUT_MS;
    const run = () => withRetry(() => withTimeout(fn(), timeoutMs, "Exa"), this.opts.retry);
    return this.opts.limiter ? this.opts.limiter.run(run) : run();
  }

  /** Non-idempotent calls (creating a paid run): bounded by a timeout, never retried. */
  private callOnce<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => withTimeout(fn(), this.opts.timeoutMs ?? EXA_TIMEOUT_MS, "Exa");
    return this.opts.limiter ? this.opts.limiter.run(run) : run();
  }

  estimateCost(q: SearchQuery): number {
    return PRICES.exaSearch + q.numResults * PRICES.exaPage;
  }

  async search(q: SearchQuery): Promise<EngineSearchOutput> {
    const options: Record<string, unknown> = {
      type: "auto",
      numResults: q.numResults,
      contents: { highlights: true },
    };
    if (q.objective) options.objective = q.objective;
    if (q.from) options.startPublishedDate = q.from;
    if (q.to) options.endPublishedDate = q.to;
    if (q.country) options.userLocation = q.country.toUpperCase();

    const res = await this.call(() => this.client.search(q.text, options));
    const results: EngineResult[] = res.results.map((r, i) => ({
      url: r.url,
      title: r.title ?? "",
      publishedDate: r.publishedDate,
      snippets: r.highlights?.length ? r.highlights : r.text ? [r.text.slice(0, 600)] : [],
      engine: "exa",
      rank: i + 1,
    }));
    return { results, costUsd: res.costDollars?.total ?? this.estimateCost(q), endpoint: "search" };
  }

  estimateFetchCost(urlCount: number): number {
    return urlCount * PRICES.exaPage;
  }

  async fetch(urls: string[], maxCharacters: number, claim?: string): Promise<FetchOutput> {
    const options = claim ? { highlights: { query: claim, maxCharacters } } : { text: { maxCharacters } };
    const res = await this.call(() => this.client.getContents(urls, options));
    const statusByUrl = new Map((res.statuses ?? []).map((s) => [s.id, s]));
    // Match each result to the URL that was asked for: by id first (the requested URL), then by
    // canonical form, so a redirect or a trailing slash does not turn a paid page into "not read".
    const byId = new Map(res.results.filter((r) => r.id).map((r) => [r.id!, r]));
    const byCanonical = new Map<string, (typeof res.results)[number]>();
    for (const r of res.results) {
      for (const key of [r.url, r.id]) if (key && !byCanonical.has(canonicalUrl(key))) byCanonical.set(canonicalUrl(key), r);
    }

    const pages: FetchedPage[] = urls.map((url) => {
      const st = statusByUrl.get(url);
      if (st && st.status !== "success") {
        const tag = st.error?.tag ?? st.status;
        return { url, status: "not_read", reason: `fetch failed: ${tag}`, text: null };
      }
      const r = byId.get(url) ?? byCanonical.get(canonicalUrl(url));
      if (!r) return { url, status: "not_read", reason: "no content returned", text: null };
      const text = claim ? r.highlights?.join("\n").slice(0, maxCharacters) : r.text;
      return {
        url,
        title: r.title ?? undefined,
        publishedDate: r.publishedDate,
        ...(claim && text?.trim()
          ? { status: "truncated" as const, text, reason: "claim highlights only, not a full page read" }
          : classifyPage(text, maxCharacters)),
      };
    });
    return { pages, costUsd: res.costDollars?.total ?? this.estimateFetchCost(urls.length) };
  }

  // ----------------------------------------------------------- agent runs

  /** Worst-case cost of a request, used to reserve budget before it starts. */
  agentWorstCase(req: AgentRunRequest): number {
    return agentWorstCase(req.effort, req.budgetUsd);
  }

  async agentCreate(req: AgentRunRequest): Promise<AgentRunLike> {
    if (!AGENT_EFFORTS.includes(req.effort)) {
      throw new EngineError(`Exa Agent effort "${req.effort}" is not allowed; use ${AGENT_EFFORTS.join(", ")}`);
    }
    const metered = req.effort === "auto" || req.effort === "ultra";
    if (metered && req.budgetUsd === undefined) {
      throw new EngineError(`Exa Agent effort "${req.effort}" is metered and always needs a budget`);
    }
    if (!metered && (req.budgetUsd !== undefined || req.maxDurationSeconds !== undefined)) {
      throw new EngineError(`Exa Agent effort "${req.effort}" is a fixed price and does not take a budget`);
    }
    if (req.maxDurationSeconds !== undefined && req.effort !== "ultra") {
      throw new EngineError("maxDurationSeconds only applies to effort ultra");
    }

    const params: Record<string, unknown> = { query: req.query, effort: req.effort };
    if (req.systemPrompt) params.systemPrompt = req.systemPrompt;
    if (req.outputSchema) params.outputSchema = req.outputSchema;
    if (req.previousRunId) params.previousRunId = req.previousRunId;
    if (req.exclusion?.length) params.input = { exclusion: req.exclusion };
    if (metered) {
      params.budget = {
        maxCostDollars: req.budgetUsd,
        ...(req.maxDurationSeconds !== undefined ? { maxDurationSeconds: req.maxDurationSeconds } : {}),
      };
    }
    // Never retried: a retry after a lost response would start a second paid run.
    // The nonce lets an ambiguous failure be resolved by finding the run that was created.
    const nonce = randomUUID();
    params.metadata = { spurhund_nonce: nonce };
    try {
      return await this.callOnce(() => this.client.agent.runs.create(params));
    } catch (err) {
      if (isRetryable(err) || err instanceof TimeoutError) {
        throw new AmbiguousCreateError(`Exa Agent create did not answer clearly (${errorMessage(err)}); the run may exist.`, nonce);
      }
      throw err;
    }
  }

  /** Looks for a run created with this nonce among the most recent runs. */
  async agentFindByNonce(nonce: string): Promise<AgentRunLike | undefined> {
    const page = await this.call(() => this.client.agent.runs.list({ limit: 25 }));
    const tagged = (r: AgentRunLike) => {
      const meta = (r.metadata ?? (r.request?.metadata as Record<string, unknown> | undefined)) ?? undefined;
      return meta?.spurhund_nonce === nonce;
    };
    return page.data.find(tagged);
  }

  agentGet(runId: string): Promise<AgentRunLike> {
    return this.call(() => this.client.agent.runs.get(runId));
  }

  /** Ends the run. `ultra` runs are stopped (partial results kept); others are cancelled. */
  async agentEnd(runId: string, effort: AgentEffortName): Promise<AgentRunLike> {
    if (effort === "ultra") return this.call(() => this.client.agent.runs.stop(runId));
    return this.call(() => this.client.agent.runs.cancel(runId));
  }
}
