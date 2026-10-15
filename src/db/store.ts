import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { canonicalUrl } from "../canonical.js";
import { newId } from "../util.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

/** source_hits engines that mark "this job saw the page" without being a search engine. */
export const PSEUDO_ENGINES: readonly string[] = ["fetch", "exa-agent", "user"];

export type JobState = "submitted" | "input_required" | "working" | "completed" | "failed" | "canceled";
export const TERMINAL_STATES: readonly JobState[] = ["completed", "failed", "canceled"];
export type PlanStatus = "awaiting_approval" | "approved";
export type ReadStatus = "unread" | "read" | "truncated" | "not_read";
export type Verification = "unchecked" | "verified" | "single_source" | "unverified" | "contradicted";

export interface PlanRow {
  id: string;
  question: string;
  depth: string;
  plan: unknown;
  worstCaseUsd: number;
  maxExaUsd: number;
  status: PlanStatus;
  createdAt: string;
  approvedAt: string | null;
}

export interface JobRow {
  id: string;
  planId: string;
  state: JobState;
  phase: string;
  pid: number | null;
  authMode: string;
  models: Record<string, string>;
  maxExaUsd: number;
  cancelRequested: boolean;
  spawnedAt: string | null;
  error: string | null;
  claudeCostUsd: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SourceRow {
  id: number;
  canonicalUrl: string;
  url: string;
  title: string | null;
  publishedDate: string | null;
  fetchedAt: string | null;
  readStatus: ReadStatus;
  fetchMaxChars: number | null;
  text: string | null;
}

export interface FindingInput {
  jobId: string;
  segment: string;
  claim: string;
  sourceIds: number[];
  sourceKind: "primary" | "secondary";
  evidence: "fetched" | "snippet";
  engine?: string;
  publishedDate?: string;
  critical?: boolean;
}

export interface FindingRow extends Required<Omit<FindingInput, "engine" | "publishedDate">> {
  id: number;
  engine: string | null;
  publishedDate: string | null;
  verification: Verification;
  verificationNote: string | null;
  createdAt: string;
}

export interface ExaRunRow {
  id: string;
  jobId: string;
  planRunId: string;
  effort: string;
  status: string;
  stopReason: string | null;
  costUsd: number;
  output: unknown;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface EngineCallInput {
  jobId?: string | null;
  engine: string;
  endpoint: string;
  query: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  costUsd: number;
}

export interface JobStats {
  sources: number;
  findings: number;
  gaps: number;
  exaRuns: number;
  engineCalls: number;
  exaCostUsd: number;
  braveCostUsd: number;
}

export interface GapRow {
  id: number;
  segment: string;
  description: string;
  resolvedNote: string | null;
  resolvedBy: number[];
}

export interface ClaudeSessionRow {
  id: number;
  jobId: string;
  role: string;
  label: string;
  costUsd: number;
  turns: number;
  subtype: string;
  durationMs: number;
  createdAt: string;
}

type Row = Record<string, unknown>;

export class Store {
  private constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date,
  ) {}

  static open(dbPath: string, clock: () => Date = () => new Date()): Store {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    // Create the file private from the start; SQLite reuses its permissions for the -wal and -shm files.
    if (!fs.existsSync(dbPath)) fs.closeSync(fs.openSync(dbPath, "a", 0o600));
    const db = new Database(dbPath);
    return Store.init(db, clock);
  }

  static memory(clock: () => Date = () => new Date()): Store {
    return Store.init(new Database(":memory:"), clock);
  }

  private static init(db: Database.Database, clock: () => Date): Store {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version === 1) db.exec("ALTER TABLE jobs ADD COLUMN spawned_at TEXT"); // v1 -> v2
    if (version >= 1 && version < 3) db.transaction(() => {
      db.exec("ALTER TABLE gaps ADD COLUMN resolved_note TEXT");
      db.exec("ALTER TABLE gaps ADD COLUMN resolved_by_json TEXT");
    })();
    if (version > SCHEMA_VERSION) {
      db.close();
      throw new Error(`Database schema v${version} is newer than this spurhund (v${SCHEMA_VERSION}); upgrade spurhund.`);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return new Store(db, clock);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return this.clock().toISOString();
  }

  // ---------------------------------------------------------------- plans

  createPlan(input: { question: string; depth: string; plan: unknown; worstCaseUsd: number; maxExaUsd: number }): string {
    const id = newId("plan");
    this.db
      .prepare(
        `INSERT INTO plans (id, question, depth, plan_json, worst_case_usd, max_exa_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.question, input.depth, JSON.stringify(input.plan), input.worstCaseUsd, input.maxExaUsd, this.now());
    return id;
  }

  getPlan(id: string): PlanRow | undefined {
    const r = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Row | undefined;
    return r && toPlan(r);
  }

  // ----------------------------------------------------------------- jobs

  /** Creates a job for an approved plan and marks the plan approved, atomically. */
  createJob(input: { planId: string; authMode: string; models: Record<string, string>; maxExaUsd: number }): string {
    const id = newId("job");
    const tx = this.db.transaction(() => {
      const upd = this.db
        .prepare("UPDATE plans SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'awaiting_approval'")
        .run(this.now(), input.planId);
      if (upd.changes === 0) throw new Error(`Plan ${input.planId} does not exist or was already started.`);
      this.db
        .prepare(
          `INSERT INTO jobs (id, plan_id, state, auth_mode, models_json, max_exa_usd, created_at)
           VALUES (?, ?, 'submitted', ?, ?, ?, ?)`,
        )
        .run(id, input.planId, input.authMode, JSON.stringify(input.models), input.maxExaUsd, this.now());
    });
    tx();
    return id;
  }

  getJob(id: string): JobRow | undefined {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return r && toJob(r);
  }

  listJobs(limit = 10): JobRow[] {
    return (this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Row[]).map(toJob);
  }

  listJobsByState(state: JobState): JobRow[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE state = ? ORDER BY created_at, rowid").all(state) as Row[]).map(toJob);
  }

  /** Atomically takes the oldest submitted job for this worker. */
  claimNextSubmitted(pid: number): JobRow | undefined {
    const tx = this.db.transaction((): string | undefined => {
      const next = this.db.prepare("SELECT id FROM jobs WHERE state = 'submitted' ORDER BY created_at, rowid LIMIT 1").get() as
        | { id: string }
        | undefined;
      if (!next) return undefined;
      const upd = this.db
        .prepare("UPDATE jobs SET state = 'working', phase = 'starting', pid = ?, started_at = ? WHERE id = ? AND state = 'submitted'")
        .run(pid, this.now(), next.id);
      return upd.changes === 1 ? next.id : undefined;
    });
    const id = tx.immediate();
    return id ? this.getJob(id) : undefined;
  }

  /** Claims a specific submitted job (used by the CLI worker for one-shot runs). */
  claimJob(id: string, pid: number): JobRow | undefined {
    const upd = this.db
      .prepare("UPDATE jobs SET state = 'working', phase = 'starting', pid = ?, started_at = ? WHERE id = ? AND state = 'submitted'")
      .run(pid, this.now(), id);
    return upd.changes === 1 ? this.getJob(id) : undefined;
  }

  setPhase(id: string, phase: string): void {
    this.db.prepare("UPDATE jobs SET phase = ? WHERE id = ?").run(phase, id);
  }

  addClaudeCost(id: string, usd: number): void {
    this.db.prepare("UPDATE jobs SET claude_cost_usd = claude_cost_usd + ? WHERE id = ?").run(usd, id);
  }

  addClaudeSession(s: Omit<ClaudeSessionRow, "id" | "createdAt">): void {
    this.db.prepare(`INSERT INTO claude_sessions (job_id, role, label, cost_usd, turns, subtype, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.jobId, s.role, s.label, s.costUsd, s.turns, s.subtype, Math.round(s.durationMs), this.now());
  }

  listClaudeSessions(jobId: string): ClaudeSessionRow[] {
    return this.db.prepare(`SELECT id, job_id AS jobId, role, label, cost_usd AS costUsd, turns, subtype,
      duration_ms AS durationMs, created_at AS createdAt FROM claude_sessions WHERE job_id = ? ORDER BY id`).all(jobId) as ClaudeSessionRow[];
  }

  /** Moves a job to a terminal state. Returns false when it was already terminal. */
  finishJob(id: string, state: "completed" | "failed" | "canceled", error?: string): boolean {
    const r = this.db
      .prepare(
        `UPDATE jobs SET state = ?, error = ?, finished_at = ?
         WHERE id = ? AND state NOT IN ('completed','failed','canceled')`,
      )
      .run(state, error ?? null, this.now(), id);
    return r.changes === 1;
  }

  /**
   * Atomically reserves a worker slot for a submitted job: succeeds only while fewer than `max`
   * jobs are running or have a freshly spawned worker that has not claimed its job yet.
   */
  markSpawned(id: string, max: number, graceMs: number): boolean {
    const cutoff = new Date(this.clock().getTime() - graceMs).toISOString();
    const tx = this.db.transaction((): boolean => {
      const busy = (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'working' OR (state = 'submitted' AND spawned_at IS NOT NULL AND spawned_at > ?)")
          .get(cutoff) as { n: number }
      ).n;
      if (busy >= max) return false;
      return this.db.prepare("UPDATE jobs SET spawned_at = ? WHERE id = ? AND state = 'submitted' AND spawned_at IS NULL").run(this.now(), id).changes === 1;
    });
    return tx.immediate();
  }

  /** Submitted jobs whose worker was spawned but never claimed them in time (it failed to start). */
  failUnclaimed(graceMs: number): string[] {
    const cutoff = new Date(this.clock().getTime() - graceMs).toISOString();
    const rows = this.db.prepare("SELECT id FROM jobs WHERE state = 'submitted' AND spawned_at IS NOT NULL AND spawned_at <= ?").all(cutoff) as { id: string }[];
    return rows.filter((r) => this.finishJob(r.id, "failed", "The worker process never started the job. Check logs/worker-<job>.log in SPURHUND_HOME.")).map((r) => r.id);
  }

  /** Submitted jobs that wait for a worker slot, oldest first. */
  listUnspawned(): JobRow[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE state = 'submitted' AND spawned_at IS NULL ORDER BY created_at, rowid").all() as Row[]).map(toJob);
  }

  /** Cancels a job that no worker has claimed yet. False when a worker got there first. */
  cancelSubmitted(id: string): boolean {
    return this.db.prepare("UPDATE jobs SET state = 'canceled', finished_at = ? WHERE id = ? AND state = 'submitted'").run(this.now(), id).changes === 1;
  }

  requestCancel(id: string): void {
    this.db.prepare("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").run(id);
  }

  isCancelRequested(id: string): boolean {
    const r = this.db.prepare("SELECT cancel_requested AS c FROM jobs WHERE id = ?").get(id) as { c: number } | undefined;
    return r?.c === 1;
  }

  /** Marks `working` jobs whose worker process is gone as failed. Returns their ids. */
  reapDeadJobs(isAlive: (pid: number) => boolean): string[] {
    const dead: string[] = [];
    for (const j of this.listJobsByState("working")) {
      if (j.pid !== null && !isAlive(j.pid)) {
        const msg = j.cancelRequested ? undefined : `Worker process ${j.pid} is gone; the job did not finish.`;
        if (this.finishJob(j.id, j.cancelRequested ? "canceled" : "failed", msg)) {
          this.addEvent(j.id, j.phase, msg ?? "Worker process is gone; job marked canceled.");
          dead.push(j.id);
        }
      }
    }
    return dead;
  }

  // --------------------------------------------------------------- events

  addEvent(jobId: string, phase: string, message: string): void {
    this.db.prepare("INSERT INTO events (job_id, ts, phase, message) VALUES (?, ?, ?, ?)").run(jobId, this.now(), phase, message);
  }

  listEvents(jobId: string, limit = 50): { ts: string; phase: string; message: string }[] {
    const rows = this.db
      .prepare("SELECT ts, phase, message FROM events WHERE job_id = ? ORDER BY id DESC LIMIT ?")
      .all(jobId, limit) as { ts: string; phase: string; message: string }[];
    return rows.reverse();
  }

  // --------------------------------------------------------- engine calls

  recordCall(c: EngineCallInput): void {
    this.db
      .prepare(
        `INSERT INTO engine_calls (job_id, engine, endpoint, query, ok, error, latency_ms, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.jobId ?? null, c.engine, c.endpoint, c.query, c.ok ? 1 : 0, c.error ?? null, Math.round(c.latencyMs), c.costUsd, this.now());
  }

  sumCost(jobId: string, engine: string): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM engine_calls WHERE job_id = ? AND engine = ?")
      .get(jobId, engine) as { s: number };
    return r.s;
  }

  costByEndpoint(jobId: string, engine: string): Record<string, number> {
    const rows = this.db
      .prepare("SELECT endpoint, SUM(cost_usd) AS usd FROM engine_calls WHERE job_id = ? AND engine = ? GROUP BY endpoint")
      .all(jobId, engine) as { endpoint: string; usd: number }[];
    return Object.fromEntries(rows.map((r) => [r.endpoint, r.usd]));
  }

  // -------------------------------------------------------------- sources

  upsertSource(input: { url: string; title?: string | null; publishedDate?: string | null }): number {
    const canon = canonicalUrl(input.url);
    const r = this.db
      .prepare(
        `INSERT INTO sources (canonical_url, url, title, published_date) VALUES (?, ?, ?, ?)
         ON CONFLICT(canonical_url) DO UPDATE SET
           title = COALESCE(NULLIF(sources.title, ''), excluded.title),
           published_date = COALESCE(NULLIF(sources.published_date, ''), excluded.published_date)
         RETURNING id`,
      )
      .get(canon, input.url, input.title ?? null, input.publishedDate ?? null) as { id: number };
    return r.id;
  }

  getSource(id: number): SourceRow | undefined {
    const r = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as Row | undefined;
    return r && toSource(r);
  }

  getSourceByUrl(url: string): SourceRow | undefined {
    const r = this.db.prepare("SELECT * FROM sources WHERE canonical_url = ?").get(canonicalUrl(url)) as Row | undefined;
    return r && toSource(r);
  }

  saveFetch(sourceId: number, f: { readStatus: ReadStatus; text: string | null; maxChars: number }): void {
    const hash = f.text ? createHash("sha256").update(f.text).digest("hex") : null;
    this.db
      .prepare("UPDATE sources SET read_status = ?, text = ?, fetch_max_chars = ?, content_hash = ?, fetched_at = ? WHERE id = ?")
      .run(f.readStatus, f.text, f.maxChars, hash, this.now(), sourceId);
  }

  /**
   * A stored fetch that may be reused: younger than the TTL and either the whole
   * page or fetched with at least as many characters as requested now.
   * A page that was not read is never reused.
   */
  getCachedFetch(url: string, ttlDays: number, requestedChars: number): SourceRow | undefined {
    if (ttlDays <= 0) return undefined;
    const s = this.getSourceByUrl(url);
    if (!s || !s.fetchedAt || s.text === null) return undefined;
    if (s.readStatus !== "read" && s.readStatus !== "truncated") return undefined;
    const ageMs = this.clock().getTime() - Date.parse(s.fetchedAt);
    if (ageMs > ttlDays * 86_400_000) return undefined;
    if (s.readStatus === "read" || (s.fetchMaxChars ?? 0) >= requestedChars) return s;
    return undefined;
  }

  addHit(h: { sourceId: number; jobId?: string | null; engine: string; rank: number; query?: string }): void {
    this.db
      .prepare("INSERT INTO source_hits (source_id, job_id, engine, rank, query) VALUES (?, ?, ?, ?, ?)")
      .run(h.sourceId, h.jobId ?? null, h.engine, h.rank, h.query ?? null);
  }

  /**
   * Search engines that returned each source within a job. Pseudo-engines
   * (`fetch`, `exa-agent`) mark that the job saw a page but are not search engines.
   */
  enginesBySource(jobId: string, opts: { includePseudo?: boolean } = {}): Map<number, string[]> {
    const rows = this.db
      .prepare("SELECT source_id AS id, engine FROM source_hits WHERE job_id = ? GROUP BY source_id, engine")
      .all(jobId) as { id: number; engine: string }[];
    const out = new Map<number, string[]>();
    for (const r of rows) {
      if (!opts.includePseudo && PSEUDO_ENGINES.includes(r.engine)) continue;
      out.set(r.id, [...(out.get(r.id) ?? []), r.engine]);
    }
    return out;
  }

  /** True when this job fetched the page (or was served it from the cache). */
  jobHasFetched(jobId: string, sourceId: number): boolean {
    return this.db.prepare("SELECT 1 FROM source_hits WHERE job_id = ? AND source_id = ? AND engine = 'fetch' LIMIT 1").get(jobId, sourceId) !== undefined;
  }

  jobHasSource(jobId: string, sourceId: number): boolean {
    return this.db.prepare("SELECT 1 FROM source_hits WHERE job_id = ? AND source_id = ? LIMIT 1").get(jobId, sourceId) !== undefined;
  }

  // ------------------------------------------------------------- findings

  addFinding(f: FindingInput): number {
    const r = this.db
      .prepare(
        `INSERT INTO findings (job_id, segment, claim, source_ids_json, source_kind, evidence, engine, published_date, critical, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.jobId,
        f.segment,
        f.claim,
        JSON.stringify([...new Set(f.sourceIds)]),
        f.sourceKind,
        f.evidence,
        f.engine ?? null,
        f.publishedDate ?? null,
        f.critical ? 1 : 0,
        this.now(),
      );
    return Number(r.lastInsertRowid);
  }

  getFinding(id: number): FindingRow | undefined {
    const r = this.db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined;
    return r && toFinding(r);
  }

  listFindings(jobId: string): FindingRow[] {
    return (this.db.prepare("SELECT * FROM findings WHERE job_id = ? ORDER BY id").all(jobId) as Row[]).map(toFinding);
  }

  setVerification(id: number, status: Verification, note?: string): void {
    this.db.prepare("UPDATE findings SET verification = ?, verification_note = ? WHERE id = ?").run(status, note ?? null, id);
  }

  setSourceIds(id: number, sourceIds: number[]): void {
    this.db.prepare("UPDATE findings SET source_ids_json = ? WHERE id = ?").run(JSON.stringify([...new Set(sourceIds)]), id);
    const f = this.getFinding(id);
    if (f) this.refreshEvidence(f.jobId, id);
  }

  refreshEvidence(jobId: string, findingId?: number): void {
    this.db.prepare(`UPDATE findings SET evidence = CASE WHEN EXISTS (
      SELECT 1 FROM json_each(findings.source_ids_json) AS cited
      JOIN sources ON sources.id = cited.value
      WHERE sources.read_status IN ('read', 'truncated') AND EXISTS (
        SELECT 1 FROM source_hits WHERE source_hits.source_id = sources.id
        AND source_hits.job_id = findings.job_id AND source_hits.engine = 'fetch'
      )
    ) THEN 'fetched' ELSE 'snippet' END
    WHERE job_id = ? AND (? IS NULL OR id = ?)`).run(jobId, findingId ?? null, findingId ?? null);
  }

  setCritical(id: number, critical: boolean): void {
    this.db.prepare("UPDATE findings SET critical = ? WHERE id = ?").run(critical ? 1 : 0, id);
  }

  /** Folds `mergeIds` into `keepId`: sources are unioned, criticality is OR-ed, the rest is deleted. */
  mergeFindings(keepId: number, mergeIds: number[], jobId?: string): void {
    const tx = this.db.transaction(() => {
      const keep = this.getFinding(keepId);
      if (!keep || (jobId !== undefined && keep.jobId !== jobId)) throw new Error(`Finding ${keepId} not found in this job`);
      const sources = new Set(keep.sourceIds);
      let critical = keep.critical;
      for (const id of mergeIds) {
        if (id === keepId) continue;
        const f = this.getFinding(id);
        if (!f || f.jobId !== keep.jobId) throw new Error(`Finding ${id} not found in the same job`);
        f.sourceIds.forEach((s) => sources.add(s));
        critical = critical || f.critical;
        this.db.prepare("DELETE FROM findings WHERE id = ?").run(id);
      }
      this.db
        .prepare("UPDATE findings SET source_ids_json = ?, critical = ? WHERE id = ?")
        .run(JSON.stringify([...sources]), critical ? 1 : 0, keepId);
      this.refreshEvidence(keep.jobId, keepId);
    });
    tx();
  }

  addGap(jobId: string, segment: string, description: string): void {
    this.db.prepare("INSERT INTO gaps (job_id, segment, description) VALUES (?, ?, ?)").run(jobId, segment, description);
  }

  listGaps(jobId: string): GapRow[] {
    return (this.db.prepare("SELECT * FROM gaps WHERE job_id = ? ORDER BY id").all(jobId) as Row[]).map((r) => ({
      id: r.id as number, segment: r.segment as string, description: r.description as string,
      resolvedNote: r.resolved_note as string | null, resolvedBy: JSON.parse((r.resolved_by_json as string | null) ?? "[]") as number[],
    }));
  }

  resolveGap(jobId: string, gapId: number, findingIds: number[], note: string): void {
    this.db.transaction(() => {
      if (!this.listGaps(jobId).some((g) => g.id === gapId)) throw new Error(`Gap ${gapId} not found in this job.`);
      if (!note.trim() || findingIds.length === 0) throw new Error("A resolution needs verified findings and a note.");
      for (const id of findingIds) {
        const f = this.getFinding(id);
        if (!f || f.jobId !== jobId || f.verification !== "verified") throw new Error(`Finding ${id} must be verified in this job.`);
      }
      this.db.prepare("UPDATE gaps SET resolved_note = ?, resolved_by_json = ? WHERE id = ? AND job_id = ?")
        .run(note, JSON.stringify([...new Set(findingIds)]), gapId, jobId);
    })();
  }

  // ------------------------------------------------------------- exa runs

  upsertExaRun(r: {
    id: string;
    jobId: string;
    planRunId: string;
    effort: string;
    status: string;
    stopReason?: string | null;
    costUsd?: number;
    output?: unknown;
    error?: string | null;
    finished?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO exa_runs (id, job_id, plan_run_id, effort, status, stop_reason, cost_usd, output_json, error, created_at, finished_at)
         VALUES (@id, @jobId, @planRunId, @effort, @status, @stopReason, @costUsd, @output, @error, @createdAt, @finishedAt)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status, stop_reason = excluded.stop_reason, cost_usd = excluded.cost_usd,
           output_json = excluded.output_json, error = excluded.error, finished_at = excluded.finished_at`,
      )
      .run({
        id: r.id,
        jobId: r.jobId,
        planRunId: r.planRunId,
        effort: r.effort,
        status: r.status,
        stopReason: r.stopReason ?? null,
        costUsd: r.costUsd ?? 0,
        output: r.output === undefined ? null : JSON.stringify(r.output),
        error: r.error ?? null,
        createdAt: this.now(),
        finishedAt: r.finished ? this.now() : null,
      });
  }

  getExaRun(id: string): ExaRunRow | undefined {
    const r = this.db.prepare("SELECT * FROM exa_runs WHERE id = ?").get(id) as Row | undefined;
    return r && toExaRun(r);
  }

  listExaRuns(jobId: string): ExaRunRow[] {
    return (this.db.prepare("SELECT * FROM exa_runs WHERE job_id = ? ORDER BY created_at, rowid").all(jobId) as Row[]).map(toExaRun);
  }

  // -------------------------------------------------------------- reports

  saveReport(jobId: string, markdown: string, json: unknown): void {
    this.db
      .prepare(
        `INSERT INTO reports (job_id, markdown, json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET markdown = excluded.markdown, json = excluded.json, created_at = excluded.created_at`,
      )
      .run(jobId, markdown, JSON.stringify(json), this.now());
  }

  getReport(jobId: string): { markdown: string; json: unknown } | undefined {
    const r = this.db.prepare("SELECT markdown, json FROM reports WHERE job_id = ?").get(jobId) as
      | { markdown: string; json: string }
      | undefined;
    return r && { markdown: r.markdown, json: JSON.parse(r.json) };
  }

  listReportJobIds(): string[] {
    return (this.db.prepare("SELECT job_id FROM reports ORDER BY created_at DESC").all() as { job_id: string }[]).map((r) => r.job_id);
  }

  // ---------------------------------------------------------------- stats

  jobStats(jobId: string): JobStats {
    const count = (sql: string) => (this.db.prepare(sql).get(jobId) as { n: number }).n;
    return {
      sources: count("SELECT COUNT(DISTINCT source_id) AS n FROM source_hits WHERE job_id = ?"),
      findings: count("SELECT COUNT(*) AS n FROM findings WHERE job_id = ?"),
      gaps: count("SELECT COUNT(*) AS n FROM gaps WHERE job_id = ? AND resolved_note IS NULL"),
      exaRuns: count("SELECT COUNT(*) AS n FROM exa_runs WHERE job_id = ?"),
      engineCalls: count("SELECT COUNT(*) AS n FROM engine_calls WHERE job_id = ?"),
      exaCostUsd: this.sumCost(jobId, "exa"),
      braveCostUsd: this.sumCost(jobId, "brave"),
    };
  }
}

// ---------------------------------------------------------------- row maps

function toPlan(r: Row): PlanRow {
  return {
    id: r.id as string,
    question: r.question as string,
    depth: r.depth as string,
    plan: JSON.parse(r.plan_json as string),
    worstCaseUsd: r.worst_case_usd as number,
    maxExaUsd: r.max_exa_usd as number,
    status: r.status as PlanStatus,
    createdAt: r.created_at as string,
    approvedAt: (r.approved_at as string | null) ?? null,
  };
}

function toJob(r: Row): JobRow {
  return {
    id: r.id as string,
    planId: r.plan_id as string,
    state: r.state as JobState,
    phase: r.phase as string,
    pid: (r.pid as number | null) ?? null,
    authMode: r.auth_mode as string,
    models: JSON.parse(r.models_json as string),
    maxExaUsd: r.max_exa_usd as number,
    cancelRequested: r.cancel_requested === 1,
    spawnedAt: (r.spawned_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    claudeCostUsd: r.claude_cost_usd as number,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

function toSource(r: Row): SourceRow {
  return {
    id: r.id as number,
    canonicalUrl: r.canonical_url as string,
    url: r.url as string,
    title: (r.title as string | null) ?? null,
    publishedDate: (r.published_date as string | null) ?? null,
    fetchedAt: (r.fetched_at as string | null) ?? null,
    readStatus: r.read_status as ReadStatus,
    fetchMaxChars: (r.fetch_max_chars as number | null) ?? null,
    text: (r.text as string | null) ?? null,
  };
}

function toFinding(r: Row): FindingRow {
  return {
    id: r.id as number,
    jobId: r.job_id as string,
    segment: r.segment as string,
    claim: r.claim as string,
    sourceIds: JSON.parse(r.source_ids_json as string) as number[],
    sourceKind: r.source_kind as "primary" | "secondary",
    evidence: r.evidence as "fetched" | "snippet",
    engine: (r.engine as string | null) ?? null,
    publishedDate: (r.published_date as string | null) ?? null,
    critical: r.critical === 1,
    verification: r.verification as Verification,
    verificationNote: (r.verification_note as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function toExaRun(r: Row): ExaRunRow {
  return {
    id: r.id as string,
    jobId: r.job_id as string,
    planRunId: r.plan_run_id as string,
    effort: r.effort as string,
    status: r.status as string,
    stopReason: (r.stop_reason as string | null) ?? null,
    costUsd: r.cost_usd as number,
    output: r.output_json ? JSON.parse(r.output_json as string) : null,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}
