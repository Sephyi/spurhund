import type { EngineId } from "../config.js";
import type { EngineResult } from "../merge.js";

export interface SearchQuery {
  text: string;
  /** Goal of the search; Exa uses it for ranking, other engines ignore it. */
  objective?: string;
  numResults: number;
  /** ISO 3166-1 alpha-2 country code that biases results. */
  country?: string;
  /** Language hint (ISO 639-1). Exa ignores it: the query's own language steers results. */
  lang?: string;
  /** Publication window, YYYY-MM-DD. */
  from?: string;
  to?: string;
}

export interface EngineSearchOutput {
  results: EngineResult[];
  costUsd: number;
  endpoint: string;
}

export interface Engine {
  readonly id: EngineId;
  search(q: SearchQuery): Promise<EngineSearchOutput>;
  /** Upper bound used to reserve budget before the call. */
  estimateCost(q: SearchQuery): number;
}

export type PageStatus = "read" | "truncated" | "not_read";

export interface FetchedPage {
  url: string;
  title?: string;
  publishedDate?: string;
  status: PageStatus;
  /** Why the page counts as not read (error tag, empty page, script shell, wall). */
  reason?: string;
  text: string | null;
}

export interface FetchOutput {
  pages: FetchedPage[];
  costUsd: number;
}

export const MAX_SEARCH_RESULTS = 25;
