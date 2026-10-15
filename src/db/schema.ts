/** Bumped whenever the schema changes; stored in PRAGMA user_version. */
export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  depth TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  worst_case_usd REAL NOT NULL,
  max_exa_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_approval',
  created_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  state TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'submitted',
  pid INTEGER,
  auth_mode TEXT NOT NULL,
  models_json TEXT NOT NULL,
  max_exa_usd REAL NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  spawned_at TEXT,
  error TEXT,
  claude_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events(job_id, id);

CREATE TABLE IF NOT EXISTS engine_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  engine TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  query TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  latency_ms INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS engine_calls_job ON engine_calls(job_id);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_url TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  title TEXT,
  published_date TEXT,
  fetched_at TEXT,
  read_status TEXT NOT NULL DEFAULT 'unread',
  fetch_max_chars INTEGER,
  text TEXT,
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS source_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  job_id TEXT,
  engine TEXT NOT NULL,
  rank INTEGER NOT NULL,
  query TEXT
);
CREATE INDEX IF NOT EXISTS source_hits_job ON source_hits(job_id);
CREATE INDEX IF NOT EXISTS source_hits_source ON source_hits(source_id);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  claim TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  evidence TEXT NOT NULL,
  engine TEXT,
  published_date TEXT,
  critical INTEGER NOT NULL DEFAULT 0,
  verification TEXT NOT NULL DEFAULT 'unchecked',
  verification_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_job ON findings(job_id);

CREATE TABLE IF NOT EXISTS gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  segment TEXT NOT NULL,
  description TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gaps_job ON gaps(job_id);

CREATE TABLE IF NOT EXISTS exa_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  plan_run_id TEXT NOT NULL,
  effort TEXT NOT NULL,
  status TEXT NOT NULL,
  stop_reason TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  output_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS exa_runs_job ON exa_runs(job_id);

CREATE TABLE IF NOT EXISTS reports (
  job_id TEXT PRIMARY KEY,
  markdown TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;
