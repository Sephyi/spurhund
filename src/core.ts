import type { Config, EngineId } from "./config.js";
import { BudgetExceededError, CostLedger, type Reservation } from "./costs.js";
import type { Store } from "./db/store.js";
import { AmbiguousCreateError, ExaEngine, isTerminalRun, type AgentRunLike, type AgentRunRequest } from "./engines/exa.js";
import { MAX_SEARCH_RESULTS, type Engine, type FetchedPage, type SearchQuery } from "./engines/types.js";
import { mergeResults, type EngineResult, type MergedResult } from "./merge.js";
import { canonicalUrl } from "./canonical.js";
import { assertPublicUrl, privateUrlReason, redact, redactQuery } from "./redact.js";
import { errorMessage } from "./util.js";

export interface CoreDeps {
  config: Pick<Config, "redact" | "fetchCacheDays" | "engines"> & { secretValues?: string[] };
  store: Store;
  engines: Partial<Record<EngineId, Engine>>;
  exa?: ExaEngine;
  /** When set, calls are attributed to this job and Exa spend is capped by `ledger`. */
  jobId?: string;
  ledger?: CostLedger;
  clock?: () => number;
}

export interface SearchInput {
  query: string;
  objective?: string;
  numResults?: number;
  engines?: EngineId[];
  country?: string;
  lang?: string;
  from?: string;
  to?: string;
}

export interface EngineReport {
  engine: string;
  ok: boolean;
  count: number;
  costUsd: number;
  error?: string;
}

export interface SearchedResult extends MergedResult {
  sourceId: number;
}

export interface SearchOutput {
  results: SearchedResult[];
  engines: EngineReport[];
  costUsd: number;
  /** Secrets or configured terms removed from the outgoing query. */
  redactions: number;
}

export interface FetchInput {
  urls: string[];
  maxCharacters?: number;
  claim?: string;
}

export interface FetchedResult extends FetchedPage {
  sourceId: number;
  cached: boolean;
}

export interface FetchOutput {
  pages: FetchedResult[];
  costUsd: number;
}

export class NoEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoEngineError";
  }
}

export const DEFAULT_FETCH_CHARS = 12_000;
export const MAX_FETCH_URLS = 10;
const MIN_FETCH_CHARS = 1_000;
const MAX_FETCH_CHARS = 60_000;

export class Core {
  private readonly now: () => number;
  private readonly searchCache = new Map<string, Promise<{ results: EngineResult[] | undefined; report: EngineReport }>>();
  private readonly runs = new Map<string, { effort: AgentRunRequest["effort"]; worstCase: number; reservation: Reservation; planRunId: string }>();

  /** Configured redaction terms plus the configured API key values themselves. */
  private readonly terms: string[];

  constructor(private readonly deps: CoreDeps) {
    this.now = deps.clock ?? Date.now;
    this.terms = [...deps.config.redact, ...(deps.config.secretValues ?? [])];
  }

  get jobId(): string | undefined {
    return this.deps.jobId;
  }

  get ledger(): CostLedger | undefined {
    return this.deps.ledger;
  }

  get store(): Store {
    return this.deps.store;
  }

  /** Engines that can actually be called right now. */
  availableEngines(): EngineId[] {
    return this.deps.config.engines.filter((e) => this.deps.engines[e]);
  }

  hasExa(): boolean {
    return Boolean(this.deps.exa);
  }

  // --------------------------------------------------------------- search

  async search(input: SearchInput): Promise<SearchOutput> {
    const { store } = this.deps;
    const { text: query, redactions: qr } = redactQuery(input.query, this.terms);
    const objective = input.objective ? redact(input.objective, this.terms) : undefined;
    const numResults = Math.min(Math.max(Math.trunc(input.numResults ?? 10), 1), MAX_SEARCH_RESULTS);

    const wanted = input.engines?.length ? input.engines : this.deps.config.engines;
    const reports: EngineReport[] = [];
    const runnable: Engine[] = [];
    for (const id of wanted) {
      const e = this.deps.engines[id];
      if (e) runnable.push(e);
      else reports.push({ engine: id, ok: false, count: 0, costUsd: 0, error: `${id} is not configured (missing API key or disabled)` });
    }
    if (runnable.length === 0) {
      throw new NoEngineError(
        `No search engine is available. ${reports.map((r) => r.error).join("; ")}. Set EXA_API_KEY and/or BRAVE_API_KEY.`,
      );
    }

    const q: SearchQuery = {
      text: query,
      objective: objective?.text || undefined,
      numResults,
      country: input.country,
      lang: input.lang,
      from: input.from,
      to: input.to,
    };

    const outcomes = await Promise.all(runnable.map((engine) => this.cachedEngineSearch(engine, q)));
    const lists = [];
    let costUsd = 0;
    for (const o of outcomes) {
      reports.push(o.report);
      costUsd += o.report.costUsd;
      if (o.results) lists.push(o.results);
    }

    const merged = mergeResults(lists);
    const results: SearchedResult[] = merged.map((m) => {
      const sourceId = store.upsertSource({ url: m.url, title: m.title, publishedDate: m.publishedDate });
      for (const f of m.foundBy) store.addHit({ sourceId, jobId: this.deps.jobId, engine: f.engine, rank: f.rank, query });
      return { ...m, sourceId };
    });

    if (!reports.some((r) => r.ok)) {
      throw new NoEngineError(`All engines failed: ${reports.map((r) => `${r.engine}: ${r.error}`).join("; ")}`);
    }
    return { results, engines: reports, costUsd, redactions: qr + (objective?.redactions ?? 0) };
  }

  private async cachedEngineSearch(engine: Engine, q: SearchQuery) {
    if (!this.deps.jobId) return this.runEngine(engine, q);
    // q has a fixed field order, independent of the caller's parameter insertion order.
    const key = JSON.stringify([engine.id, q]);
    const cached = this.searchCache.get(key);
    if (cached) {
      const out = await cached;
      return { ...out, report: { ...out.report, costUsd: 0 } };
    }
    const pending = this.runEngine(engine, q);
    this.searchCache.set(key, pending);
    const out = await pending;
    if (!out.report.ok) this.searchCache.delete(key);
    return out;
  }

  private async runEngine(engine: Engine, q: SearchQuery) {
    const { store, ledger, jobId } = this.deps;
    let reservation: Reservation | undefined;
    const started = this.now();
    try {
      if (engine.id === "exa" && ledger) reservation = ledger.reserve(engine.estimateCost(q));
      const out = await engine.search(q);
      reservation?.settle(out.costUsd);
      store.recordCall({ jobId, engine: engine.id, endpoint: out.endpoint, query: q.text, ok: true, latencyMs: this.now() - started, costUsd: out.costUsd });
      return { results: out.results, report: { engine: engine.id, ok: true, count: out.results.length, costUsd: out.costUsd } as EngineReport };
    } catch (err) {
      reservation?.release();
      const message = err instanceof BudgetExceededError ? err.message : errorMessage(err);
      store.recordCall({ jobId, engine: engine.id, endpoint: "search", query: q.text, ok: false, error: message, latencyMs: this.now() - started, costUsd: 0 });
      return { results: undefined, report: { engine: engine.id, ok: false, count: 0, costUsd: 0, error: message } as EngineReport };
    }
  }

  // ---------------------------------------------------------------- fetch

  async fetch(input: FetchInput): Promise<FetchOutput> {
    const { store, config, ledger, jobId } = this.deps;
    const maxChars = Math.min(Math.max(Math.trunc(input.maxCharacters ?? DEFAULT_FETCH_CHARS), MIN_FETCH_CHARS), MAX_FETCH_CHARS);
    const claim = input.claim ? redactQuery(input.claim, this.terms).text : undefined;

    if (input.urls.length === 0) throw new Error("Give at least one URL.");
    if (input.urls.length > MAX_FETCH_URLS) throw new Error(`At most ${MAX_FETCH_URLS} URLs per call.`);
    for (const u of input.urls) {
      if (!/^https?:\/\//i.test(u)) throw new Error(`Only http(s) URLs can be fetched: ${u}`);
      assertPublicUrl(u, this.terms);
    }
    // One fetch per page, whatever the spelling (http/https, tracking parameters, trailing slash).
    const byCanonical = new Map<string, string>();
    for (const u of input.urls) if (!byCanonical.has(canonicalUrl(u))) byCanonical.set(canonicalUrl(u), u);
    const urls = [...byCanonical.values()];

    if (jobId) {
      // Inside a job only pages the job has already seen can be fetched. A fetched page that says
      // "now open https://attacker.example/?d=<your question>" cannot make Exa deliver it.
      const unseen = urls.filter((u) => {
        const s = store.getSourceByUrl(u);
        return !s || !store.jobHasSource(jobId, s.id);
      });
      if (unseen.length) {
        throw new Error(`Only URLs returned by a search or an Exa run in this job can be fetched; search for these first: ${unseen.join(", ")}`);
      }
    }

    const clipToRequest = (r: FetchedResult): FetchedResult =>
      r.text !== null && r.text.length > maxChars ? { ...r, text: r.text.slice(0, maxChars), status: "truncated" } : r;

    const out = new Map<string, FetchedResult>();
    const todo: string[] = [];
    for (const url of urls) {
      const cached = claim ? undefined : store.getCachedFetch(url, config.fetchCacheDays, maxChars);
      if (cached) {
        out.set(
          url,
          clipToRequest({
            url,
            title: cached.title ?? undefined,
            publishedDate: cached.publishedDate ?? undefined,
            status: cached.readStatus === "read" ? "read" : "truncated",
            text: cached.text,
            sourceId: cached.id,
            cached: true,
          }),
        );
      } else todo.push(url);
    }

    let costUsd = 0;
    if (todo.length) {
      const exa = this.deps.exa;
      if (!exa) throw new NoEngineError("Fetching pages needs Exa; set EXA_API_KEY.");
      const reservation = ledger?.reserve(exa.estimateFetchCost(todo.length));
      const started = this.now();
      let res;
      try {
        res = await exa.fetch(todo, maxChars, claim);
      } catch (err) {
        reservation?.release();
        store.recordCall({ jobId, engine: "exa", endpoint: "contents", query: todo.join(" "), ok: false, error: errorMessage(err), latencyMs: this.now() - started, costUsd: 0 });
        throw err;
      }
      reservation?.settle(res.costUsd);
      costUsd = res.costUsd;
      store.recordCall({ jobId, engine: "exa", endpoint: "contents", query: todo.join(" "), ok: true, latencyMs: this.now() - started, costUsd: res.costUsd });
      for (const page of res.pages) {
        const previous = store.getSourceByUrl(page.url);
        const sourceId = store.upsertSource({ url: page.url, title: page.title, publishedDate: page.publishedDate });
        if (page.status === "not_read" && previous?.text && (previous.readStatus === "read" || previous.readStatus === "truncated")) {
          // A failed refetch (timeout, wall) never destroys a copy that was read before.
          out.set(
            page.url,
            clipToRequest({
              url: page.url,
              title: previous.title ?? undefined,
              publishedDate: previous.publishedDate ?? undefined,
              status: previous.readStatus,
              text: previous.text,
              reason: `refetch failed (${page.reason ?? "not read"}); showing the earlier copy`,
              sourceId,
              cached: true,
            }),
          );
          continue;
        }
        // Highlights are claim-specific and must never satisfy a later full-text cache lookup.
        store.saveFetch(sourceId, { readStatus: page.status, text: page.text, maxChars: claim ? 0 : maxChars });
        out.set(page.url, { ...page, sourceId, cached: false });
      }
    }
    if (jobId) {
      // Fetching a URL counts as having read it in this job, even when it came from the cache.
      for (const p of out.values()) if (p.status !== "not_read") store.addHit({ sourceId: p.sourceId, jobId, engine: "fetch", rank: 0 });
    }
    return { pages: urls.map((u) => out.get(u)!), costUsd };
  }

  /** Registers URLs the user supplied (in the question or notes) as seen by this job, so they can be fetched. */
  seedUserUrls(text: string): number {
    const { store, jobId } = this.deps;
    if (!jobId) return 0;
    let n = 0;
    for (const m of text.matchAll(/\bhttps?:\/\/[^\s"'<>()]+/gi)) {
      const url = m[0].replace(/[.,;:!?]+$/, "");
      if (privateUrlReason(url, this.terms)) continue;
      store.addHit({ sourceId: store.upsertSource({ url }), jobId, engine: "user", rank: 0 });
      n++;
    }
    return n;
  }

  /** True when a search, fetch or Exa run in this job produced the source. */
  jobHasSeen(sourceId: number): boolean {
    return this.deps.jobId ? this.deps.store.jobHasSource(this.deps.jobId, sourceId) : false;
  }

  // -------------------------------------------------------------- sources

  /** Source ids for URLs a finding cites; unknown URLs are registered. */
  resolveSources(urls: string[]): number[] {
    return [...new Set(urls.map((u) => this.deps.store.upsertSource({ url: u })))];
  }

  // ----------------------------------------------------------- Exa agents

  private requireExa(): ExaEngine {
    if (!this.deps.exa) throw new NoEngineError("Exa Agent runs need Exa; set EXA_API_KEY.");
    return this.deps.exa;
  }

  /** Reserves the worst case against the job cap, then starts the run. */
  async agentStart(planRunId: string, req: AgentRunRequest): Promise<AgentRunLike> {
    const exa = this.requireExa();
    const { store, ledger, jobId } = this.deps;
    if (!jobId) throw new Error("Exa Agent runs belong to a job.");
    // The run's task text leaves the machine like a search query does.
    req = {
      ...req,
      query: redactQuery(req.query, this.terms).text,
      systemPrompt: req.systemPrompt ? redact(req.systemPrompt, this.terms).text : undefined,
    };
    const worstCase = exa.agentWorstCase(req);
    const reservation = ledger?.reserve(worstCase);
    try {
      let run: AgentRunLike;
      try {
        run = await exa.agentCreate(req);
      } catch (err) {
        if (!(err instanceof AmbiguousCreateError)) throw err;
        // The response was lost: find the run Exa may have started instead of starting another.
        const found = await exa.agentFindByNonce(err.nonce).catch(() => undefined);
        if (!found) {
          // Unknown whether a run exists: charge its worst case so the cap stays honest.
          reservation?.settle(worstCase);
          store.recordCall({ jobId, engine: "exa", endpoint: "agent", query: planRunId, ok: false, error: err.message, latencyMs: 0, costUsd: worstCase });
          throw new Error(`${err.message} No matching run was found; charged the worst case ($${worstCase.toFixed(2)}) to the job. Check the Exa dashboard for an orphaned run.`);
        }
        run = found;
      }
      this.runs.set(run.id, { effort: req.effort, worstCase, reservation: reservation ?? { settle() {}, release() {} }, planRunId });
      store.upsertExaRun({ id: run.id, jobId, planRunId, effort: req.effort, status: run.status });
      if (isTerminalRun(run)) this.persistRun(run);
      return run;
    } catch (err) {
      reservation?.release(); // no-op when already settled above
      throw err;
    }
  }

  async agentGet(runId: string): Promise<AgentRunLike> {
    const run = await this.requireExa().agentGet(runId);
    this.persistRun(run);
    return run;
  }

  /** Stops (ultra) or cancels the run and settles its cost when the answer shows it is over. */
  async agentEnd(runId: string): Promise<AgentRunLike> {
    const meta = this.runs.get(runId);
    if (!meta) throw new Error(`Unknown Exa run ${runId}`);
    const exa = this.requireExa();
    let run: AgentRunLike | undefined;
    let endError: unknown;
    try {
      run = await exa.agentEnd(runId, meta.effort); // the response is the run in its new state
    } catch (err) {
      endError = err; // the run may have finished in the meantime; read its state instead
    }
    // A terminal stop/cancel answer may omit the final cost; read the run once more for it.
    if (!run || !isTerminalRun(run) || run.costDollars?.total === undefined) {
      try {
        run = await exa.agentGet(runId);
      } catch (err) {
        if (!run) throw endError ?? err;
      }
    }
    this.persistRun(run);
    if (!isTerminalRun(run) && endError) throw endError;
    return run;
  }

  /** True while a run is tracked and its cost is not settled yet. */
  agentIsOpen(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * Gives up on a run whose final state cannot be read: it may still be running at Exa,
   * so its worst case is charged and the run is recorded as abandoned.
   */
  agentAbandon(runId: string, reason: string): number {
    const meta = this.runs.get(runId);
    if (!meta) return 0;
    const { store, jobId } = this.deps;
    meta.reservation.settle(meta.worstCase);
    this.runs.delete(runId);
    if (jobId) {
      store.upsertExaRun({ id: runId, jobId, planRunId: meta.planRunId, effort: meta.effort, status: "abandoned", costUsd: meta.worstCase, error: reason, finished: true });
    }
    store.recordCall({ jobId, engine: "exa", endpoint: "agent", query: meta.planRunId, ok: false, error: reason, latencyMs: 0, costUsd: meta.worstCase });
    return meta.worstCase;
  }

  private persistRun(run: AgentRunLike): void {
    const { store, jobId } = this.deps;
    const meta = this.runs.get(run.id);
    if (!jobId || !meta) return;
    const terminal = isTerminalRun(run);
    const cost = terminal ? this.runCost(run, meta.worstCase) : undefined;
    store.upsertExaRun({
      id: run.id,
      jobId,
      planRunId: meta.planRunId,
      effort: meta.effort,
      status: run.status,
      stopReason: run.stopReason ?? null,
      costUsd: cost ?? 0,
      output: terminal ? run.output : undefined,
      error: run.error?.message ?? null,
      finished: terminal,
    });
    if (terminal) this.settleRun(run);
  }

  /** A finished run without a reported cost is charged at its worst case. */
  private runCost(run: AgentRunLike, worstCase: number): number {
    return run.costDollars?.total ?? (run.status === "completed" ? worstCase : 0);
  }

  private settleRun(run: AgentRunLike): void {
    const meta = this.runs.get(run.id);
    if (!meta) return;
    const cost = this.runCost(run, meta.worstCase);
    meta.reservation.settle(cost);
    this.runs.delete(run.id);
    this.deps.store.recordCall({
      jobId: this.deps.jobId,
      engine: "exa",
      endpoint: "agent",
      query: meta.planRunId,
      ok: run.status === "completed",
      error: run.status === "completed" ? undefined : (run.error?.message ?? run.status),
      latencyMs: 0,
      costUsd: cost,
    });
  }
}
