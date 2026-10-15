import { PRICES } from "../costs.js";
import type { EngineResult } from "../merge.js";
import { EngineError, Limiter, withRetry, type RetryOptions } from "../util.js";
import type { Engine, EngineSearchOutput, SearchQuery } from "./types.js";

const BASE_URL = "https://api.search.brave.com/res/v1";

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

interface LlmContextResponse {
  grounding?: { generic?: { url: string; title?: string; snippets?: string[] }[] };
  sources?: Record<string, { title?: string; hostname?: string; age?: string[] | string | null }>;
}

/** Brave `YYYY-MM-DDtoYYYY-MM-DD` range; an open end is filled in. */
export function braveFreshness(from?: string, to?: string, today = new Date()): string | undefined {
  if (!from && !to) return undefined;
  return `${from ?? "1970-01-01"}to${to ?? today.toISOString().slice(0, 10)}`;
}

function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  return Number.isFinite(secs) ? secs * 1000 : undefined;
}

/**
 * Brave Search API, `llm/context` endpoint: pre-extracted page snippets in one
 * call, auth through the X-Subscription-Token header.
 */
export class BraveEngine implements Engine {
  readonly id = "brave" as const;

  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      fetchImpl?: FetchLike;
      limiter?: Limiter;
      retry?: RetryOptions;
      baseUrl?: string;
      timeoutMs?: number;
      today?: () => Date;
    } = {},
  ) {}

  estimateCost(): number {
    return PRICES.braveRequest;
  }

  async search(q: SearchQuery): Promise<EngineSearchOutput> {
    const url = new URL(`${this.opts.baseUrl ?? BASE_URL}/llm/context`);
    const count = Math.min(Math.max(q.numResults, 1), 50);
    url.searchParams.set("q", q.text);
    url.searchParams.set("count", String(count));
    url.searchParams.set("maximum_number_of_urls", String(count));
    if (q.country) url.searchParams.set("country", q.country.toUpperCase());
    if (q.lang) url.searchParams.set("search_lang", q.lang.toLowerCase());
    const fresh = braveFreshness(q.from, q.to, this.opts.today?.());
    if (fresh) url.searchParams.set("freshness", fresh);

    const doFetch = this.opts.fetchImpl ?? ((u, init) => fetch(u, init));
    const run = () =>
      withRetry(async () => {
        const res = await doFetch(url.toString(), {
          headers: { Accept: "application/json", "X-Subscription-Token": this.apiKey },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
        if (!res.ok) {
          const body = (await res.text().catch(() => "")).slice(0, 300);
          throw new EngineError(`Brave API ${res.status}: ${body || res.statusText}`, res.status, parseRetryAfter(res.headers.get("retry-after")));
        }
        return (await res.json()) as LlmContextResponse;
      }, this.opts.retry);
    const data = await (this.opts.limiter ? this.opts.limiter.run(run) : run());

    const results: EngineResult[] = (data.grounding?.generic ?? []).map((g, i) => ({
      url: g.url,
      title: g.title ?? data.sources?.[g.url]?.title ?? "",
      snippets: g.snippets ?? [],
      engine: "brave",
      rank: i + 1,
    }));
    return { results, costUsd: PRICES.braveRequest, endpoint: "llm/context" };
  }
}
