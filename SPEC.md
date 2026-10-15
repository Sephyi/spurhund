# spurhund: specification

Status: draft for approval, 2026-10-15. No code exists yet.
Working name: `spurhund` (German for tracking dog; the npm name is free as of 2026-10-15).

## 1. Purpose

A local research system for one user on macOS. Later it moves to a small VM. It does two things:

1. Gives Claude clients a better search and fetch: Exa (the full API) and Brave in one call, deduplicated, with the engine recorded for every result.
2. Runs research jobs on its own on the Claude Agent SDK: plan, approval, parallel segment research, merge, gap pass, verification, report.

It is exposed as an MCP server, plus a small CLI for the terminal and cron.

Non-goals for now:

- A2A
- Multi-user
- HTTP transport or OAuth for the server
- Exa Monitors
- Vectors

These are listed in section 12.

## 2. Architecture

```text
┌──────────────── MCP server (stdio) ──────────────────────────┐
│ search · fetch · plan_research · start_research ·            │
│ research_status · research_result · cancel_research ·        │
│ list_jobs · resources spurhund://reports/{job_id}.{md,json}  │
└──────────────┬──────────────────────────────┬────────────────┘
               │ direct calls                 │ spawns detached
               ▼                              ▼
┌──────── core library ────────┐   ┌──── worker process ──────────────┐
│ engines: exa, brave          │◄──│ Claude Agent SDK                 │
│ merge / canonical URLs       │   │ orchestrator + segment subagents │
│ cost ledger                  │   │ + verifier, tools = in-process   │
│ SQLite store (better-sqlite3)│◄──│ SDK MCP server over the core     │
└──────────────────────────────┘   └──────────────────────────────────┘
```

- Research jobs run in a detached worker process (`spurhund worker --job <id>`), not inside the MCP server. A job survives the client closing, a restart of Claude Code, or a Desktop timeout. All state lives in SQLite (WAL mode), and the server and the CLI read it from there.
- At most `SPURHUND_MAX_CONCURRENT_JOBS` workers run at once. Additional jobs wait as `submitted`.
- Every MCP tool returns in under 240 s, which is the claude.ai and Desktop limit. Long work only ever goes through the job tools.

## 3. Configuration

Configuration comes from environment variables only, set in the MCP client config or the shell. Invalid values abort startup with a clear message.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPURHUND_HOME` | `~/.claude/spurhund` | Data directory: `spurhund.db`, `reports/`, `logs/` |
| `SPURHUND_AUTH` | `oauth` | `oauth` uses `CLAUDE_CODE_OAUTH_TOKEN`; `api` uses `ANTHROPIC_API_KEY` |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | From `claude setup-token`; required for `oauth` |
| `ANTHROPIC_API_KEY` | — | Required for `api` |
| `EXA_API_KEY` | — | Required |
| `BRAVE_API_KEY` | — | Optional; without it, Brave is disabled and reports say so |
| `SPURHUND_ENGINES` | `exa,brave` | Engines for `search` and the worker |
| `SPURHUND_MODEL_ORCHESTRATOR` | `claude-opus-5-5` | Planning, merging, report |
| `SPURHUND_MODEL_WORKER` | `claude-sonnet-5-5` | Segment subagents (e.g. `claude-haiku-5-5` for testing) |
| `SPURHUND_MODEL_VERIFIER` | value of the worker model | Verification subagent |
| `SPURHUND_EFFORT_ORCHESTRATOR` | `high` | Claude effort; `medium`, `high`, `xhigh`, or `max` |
| `SPURHUND_EFFORT_WORKER` | `medium` | Same values |
| `SPURHUND_EFFORT_VERIFIER` | `high` | Same values |
| `SPURHUND_EXA_MAX_USD_PER_JOB` | `5` | Hard cap on Exa spend per job, enforced by the ledger |
| `SPURHUND_MAX_TURNS` | `200` | Agent SDK `maxTurns` per worker |
| `SPURHUND_MAX_BUDGET_USD` | unset | Agent SDK `maxBudgetUsd`. It is a client-side estimate; with `oauth` it limits subscription usage, not a bill |
| `SPURHUND_MAX_CONCURRENT_JOBS` | `2` | Parallel worker processes |
| `SPURHUND_REDACT` | unset | Comma-separated terms (internal hostnames, names) removed from every outgoing query |
| `SPURHUND_LOG_LEVEL` | `info` | Logs go to stderr and `logs/`, never to stdout (stdio MCP) |

Rules:

- Effort `low` and `minimal` are rejected for both Claude and Exa.
- Auth is chosen explicitly. Claude Code picks `ANTHROPIC_API_KEY` over `CLAUDE_CODE_OAUTH_TOKEN` when both are set, so the worker passes the SDK a cleaned `env`:
  - In `oauth` mode, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed.
  - In `api` mode, `CLAUDE_CODE_OAUTH_TOKEN` is removed.

  Every report records which mode it used.
- Secrets never go into the repo, the DB, or the logs. `scripts/spurhund-keychain` is an optional wrapper that reads the keys from the macOS Keychain (`security find-generic-password`) and starts the server.

## 4. Engines

There is one interface for all engines:

```ts
interface Engine {
  id: "exa" | "brave";
  search(q: SearchQuery): Promise<EngineResult[]>;
}
type SearchQuery = { text: string; objective?: string; numResults: number;
  country?: string; lang?: string; freshness?: { from: string; to: string } };
type EngineResult = { url: string; title: string; publishedDate?: string;
  snippets: string[]; engine: string; rank: number };
```

### Exa (`exa-js` 2.25.0)

- **Search:** `exa.search` with type `auto` and highlights by default. Deep Search (`deep-lite`, `deep`, `deep-reasoning`, with `outputSchema`) is used only where the plan asks for it.
- **Fetch:** `exa.getContents` with `maxCharacters` (default 12000) and a cache. A failed fetch is marked `not_read`. Empty pages, JavaScript shells and walls also count as not read.
- **Agent:** `exa.agent.runs.create`, `get`, `pollUntilFinished`, `stop` and `cancel`.
  - Effort is `medium`, `high`, `xhigh`, `auto` or `ultra`.
  - `auto` and `ultra` always get `budget.maxCostDollars`; `ultra` also gets `maxDurationSeconds`.
  - When a job is cancelled, an `ultra` run is ended with `stop`, which keeps the partial results. Other runs are ended with `cancel`.
- **Cost:** taken from `costDollars` in the response, otherwise from the price table in `src/costs.ts` (search $7 per 1k, contents $1 per 1k, agent per effort).

### Brave (REST via `fetch`, header `X-Subscription-Token`)

- Primary endpoint: `GET https://api.search.brave.com/res/v1/llm/context` with `q`, `count`, `country`, `search_lang`, `freshness` (`YYYY-MM-DDtoYYYY-MM-DD`), and `maximum_number_of_tokens`.
- `GET /res/v1/web/search` is used only when titles or dates are missing.
- Cost: $5 per 1k requests. The monthly free credits are not counted.

### Shared behavior

- Retry with backoff on 429 and 5xx: at most 3 attempts, honoring `Retry-After`.
- A per-engine concurrency limit (Exa 5, Brave 5).
- Every call is written to `engine_calls`.

## 5. Merging

- **Canonical URL:**
  - Hostname lowercase, `www.` removed.
  - Fragment removed.
  - Tracking parameters removed (`utm_*`, `gclid`, `fbclid`, `ref`).
  - Trailing slash removed.
  - Path case kept as is.
- **Results:** grouped by canonical URL. Each result keeps `foundBy: [{engine, rank}]` and the earliest known publication date.
- **Findings:** merged by the orchestrator at the content level (same entity or same claim). The code only enforces that every finding points to at least one stored source.

## 6. Research worker (Claude Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.300)

SDK settings:

- `settingSources: []`: the user's CLAUDE.md, skills, and plugins don't leak in.
- `tools: []` plus `allowedTools`: only the SDK's own `mcp__spurhund__*` tools and the Agent tool.
- `permissionMode: "dontAsk"`.
- No Bash, no file tools, no native web search.

The model can therefore only search, fetch, and start Exa Agent runs. It cannot write or execute anything, which limits the damage a prompt injection in fetched pages can do.

Tools of the in-process SDK MCP server (`createSdkMcpServer`):

- `search`: all configured engines, merged
- `fetch`
- `exa_agent_start` and `exa_agent_get`
- `record_finding` and `record_gap`, which write to SQLite

Every tool checks the Exa ledger before spending. Once the cap is reached it returns an error, and the job continues with what it has.

Phases, each logged as an event:

1. **Plan** (orchestrator, `outputFormat` JSON schema), producing:
   - question, absolute time window
   - segments, angles, and languages: English always, German for German or EU topics, others only if requested
   - engines per segment, Exa Agent runs with effort and budget
   - number of subagents
   - worst-case Exa cost

   The job then stops in state `input_required` until `start_research` approves it.
2. **Execute:** one subagent per segment, in parallel (worker model). Each subagent gets the brief from the skill: time window, languages, engines, the rules, and the findings format `claim | URL | date | primary/secondary | fetched/snippet | engine`. Exa Agent runs from the plan start in parallel.
3. **Merge** (orchestrator): deduplicate, merge entities, evaluate per-engine provenance.
4. **Gap pass:** at most one round of targeted follow-up searches for missing periods, regions, types, or languages.
5. **Verify** (verifier):
   - Fetch only material claims that nobody has read in full; never re-fetch a page already read.
   - For decision-critical claims, look for an independent second source.
   - Statuses: `verified`, `single_source`, `unverified`, `contradicted`.
6. **Report:** Markdown plus JSON, saved under `reports/` and in the DB.
   - Contents: summary, findings with sources and verification status, segment coverage (well covered or thin), gaps.
   - Sources found by only one engine.
   - Costs (Exa per endpoint, Brave, Claude estimate), auth mode, and models.
   - The words "complete" or "all" are not used.

Depth presets for `plan_research` set the defaults the planner works with:

| `depth` | Segments | Exa Agent | Gap pass | Verify |
| --- | --- | --- | --- | --- |
| `standard` | 1–3 | none or `medium` | no | material claims |
| `deep` | 3–6 | `high` per segment | yes | material and critical |
| `exhaustive` | 4–10 | `xhigh`, or `auto` with cap; `ultra` only when requested | yes | material and critical |

## 7. MCP server (`@modelcontextprotocol/server` 2.3.1, transport `@modelcontextprotocol/server/stdio`)

All tools declare `readOnlyHint` and `destructiveHint`; claude.ai requires both, so they are already in place for a later HTTP transport. All tools return text plus `structuredContent`.

| Tool | Input | Output | Spends money |
| --- | --- | --- | --- |
| `search` | `query`, `objective?`, `num_results` (≤25), `engines?`, `country?`, `lang?`, `from?`, `to?` | Merged results with `foundBy` and snippets | Yes, per call |
| `fetch` | `urls[]` (≤10), `max_characters?` | Text per URL or `not_read` with a reason | Yes |
| `plan_research` | `question`, `depth`, `languages?`, `time_window?`, `max_exa_usd?`, `notes?` | `plan_id`, the plan, worst-case cost | Only Claude tokens or subscription |
| `start_research` | `plan_id`, `approve: true`, `max_exa_usd?` | `job_id` | Yes, up to the cap |
| `research_status` | `job_id` | State, phase, counts (sources, findings, runs), spend so far | No |
| `research_result` | `job_id`, `format: summary \| full` | Report (`full` up to 100k characters, otherwise a resource link) | No |
| `cancel_research` | `job_id` | Final state; partial results stay readable | No |
| `list_jobs` | `limit?` | The latest jobs with state and cost | No |

- Job states (aligned with A2A): `submitted`, `input_required`, `working`, `completed`, `failed`, `canceled`.
- Resources: `spurhund://reports/{job_id}.md` and `.json`.

## 8. CLI

- `spurhund serve`: the MCP server (stdio)
- `spurhund search "<query>"`
- `spurhund plan "<question>" --depth deep`, which prints the plan and its ID
- `spurhund start <plan_id>`
- `spurhund status [job_id]`
- `spurhund result <job_id>`
- `spurhund cancel <job_id>`
- `spurhund worker --job <id>`, internal

## 9. Storage (`better-sqlite3` 13.0.3, WAL)

| Table | Contents |
| --- | --- |
| `plans` | Question, depth, plan JSON, worst-case cost, created_at |
| `jobs` | plan_id, state, phase, pid, auth mode, models, started/finished, error |
| `events` | job_id, timestamp, phase, message (progress log) |
| `engine_calls` | job_id?, engine, endpoint, query (after redaction), status, latency, cost_usd |
| `sources` | canonical_url, url, title, published_date, fetched_at, read_full, text, content_hash |
| `source_hits` | source_id, job_id, engine, rank |
| `findings` | job_id, segment, claim, source_ids, primary/secondary, fetched/snippet, critical, verification |
| `gaps` | job_id, segment, description |
| `reports` | job_id, markdown, json, created_at |

Fetched texts are reused as a cache: identical canonical URLs are not fetched again within 7 days (configurable).

## 10. Safety and costs

- Nothing in the worker spends money before the plan is approved.
- Exa spend is capped hard per job (ledger). `auto` and `ultra` always carry `budget.maxCostDollars`, which is never above the remaining job budget.
- Before every outgoing query, the terms from `SPURHUND_REDACT` and obvious secret patterns (API keys, tokens, private keys) are removed.
- Fetched content is data. Prompts say so, and the tool set makes harmful actions impossible.
- No writes outside `SPURHUND_HOME`.

## 11. Stack, layout, tests

Stack:

- Runtime Node 20+ or Bun 1.4+ (both tested), TypeScript strict, ESM, Bun as package manager (`bun.lock`; npm works too), exact versions in `package.json`, vitest as the test runner.
- Libraries: `@anthropic-ai/claude-agent-sdk` 0.3.300, `exa-js` 2.25.0, `@modelcontextprotocol/server` 2.3.1, `better-sqlite3` 13.0.3, `zod` 4.6.7.
- Dev tools: `typescript`, `vitest`, `tsx`.

```text
spurhund/
  package.json  tsconfig.json  README.md  SPEC.md
  src/
    config.ts  costs.ts  redact.ts  merge.ts  canonical.ts
    db/{schema.sql, store.ts}
    engines/{types.ts, exa.ts, brave.ts}
    worker/{run.ts, plan.ts, prompts.ts, tools.ts}
    mcp/server.ts
    cli.ts
  scripts/spurhund-keychain
  test/
```

Tests, all of which have to pass:

- Unit tests, no network:
  - URL canonicalization and merging
  - cost ledger and cap enforcement
  - config validation (rejects `low`, auth selection and env cleanup)
  - redaction
  - job state machine
  - engine adapters against recorded responses
- MCP integration test with an in-memory client: tool list, schemas, annotations, `search` with mocked engines, the job lifecycle with a mocked worker.
- Live smoke test, only after your approval and with a stated cost:
  - `search` and `fetch` against Exa and Brave: well under $0.10.
  - Later, on your Mac, one `standard` job: Exa under $1, plus subscription usage.
  - This needs `EXA_API_KEY` and `BRAVE_API_KEY` in the environment.

## 12. Milestones

1. Core, engines, DB, `search`/`fetch` tools, CLI `search`, tests.
2. Worker (plan, execute, merge, gap, verify, report), job tools, resources, tests.
3. Installation:
   - `claude mcp add` for the CLI and the Desktop Code tab
   - a `claude_desktop_config.json` example for Desktop Chat
   - the Keychain wrapper
   - a new route row in the search-routing skill for spurhund
4. Later, each to be approved separately:
   - HTTP transport and OAuth for the VM.
   - Semantic memory with `sqlite-vec` 0.1.9. It is a loadable extension for `better-sqlite3`, which itself has no vectors. It would provide semantic dedup across engines and "have I researched this before". It needs an embedding model, which Anthropic doesn't offer; the options are the Voyage API (key, paid) or a local model.
   - Exa Monitors as a watch on advisories for your stack.
   - An A2A facade.
   - Native WebSearch as a third engine.

## 13. As built: deviations from and additions to the approved draft

Status 2026-10-15: milestones 1 and 2 are implemented and tested offline; milestone 3 is done except the live runs. Where this section and the sections above disagree, this section is what the code does.

### Deviations

| Draft | As built | Why |
| --- | --- | --- |
| §6: one subagent per segment through the SDK's `Agent` tool | One separate Claude Agent SDK session per segment, started by the pipeline in parallel (at most 4 at once) | Deterministic parallelism, a per-segment turn cap and cost, and a fake runner for tests |
| §6: model tools `exa_agent_start` / `exa_agent_get` | The pipeline starts and polls the planned Exa Agent runs itself; sessions get `exa_run_output` to read results | Exa spend stays inside the ledger and the approved plan; a model cannot start runs |
| §7: job state `input_required` while the plan waits | The plan is a record (`plans.status`: `awaiting_approval` / `approved`); a job exists only after `start_research`. `input_required` stays in the state enum, unused | The draft described both a plan id and a job id for the same step |
| §7: `plan_research` inputs | Adds `allow_ultra` (default false) | `ultra` must be an explicit request |
| §5: canonical URL | The scheme is normalised to `https` as well | `http` and `https` copies of a page are one source |
| §11: layout | Adds `services.ts`, `runtime.ts`, `jobs.ts`, `worker/{plan,prompts,tools,runner,planner,pipeline,report,main}.ts`, `mcp/{jobTools,format}.ts`, `test/live/` | |

### Additions

- **Config:** `SPURHUND_FETCH_CACHE_DAYS` (default 7).
- **Tables:** `exa_runs` (one row per Exa Agent run of a job, with output and cost). `source_hits.engine` also holds the pseudo-engines `fetch` and `exa-agent`; they mark that a job saw a page and are not counted as search engines in provenance.
- **Worker tools** (all roles get a subset): `search`, `fetch`, `record_finding`, `record_gap`, `list_findings`, `merge_findings`, `set_verification`, `exa_run_output`.
  - `record_finding` rejects URLs that no search, fetch or Exa run in the same job returned. The `fetched`/`snippet` flag and the engines are computed from the database, not taken from the model.
  - `set_verification` downgrades `verified` to `unverified` when no cited page was read in full, and to `single_source` for a critical finding with fewer than two independent hosts that were read.
  - After the verify phase, findings that are still `unchecked` become `unverified`.
- **Plan validation (code, not model):** segment count per depth; languages limited to English, German and the ones the user approved; engines must be available; Exa Agent effort per depth, budgets for `auto`/`ultra`, `ultra` only with `allow_ultra`; worst-case Exa cost must not exceed the cap. One correction round for the planner, then an error. The planner may spend at most $0.30 on calibration searches.
- **Privacy:**
  - `fetch` refuses localhost, single-label hosts, `.local`/`.internal`/`.lan`/`.home`/`.corp`/`.intranet`/`.home.arpa` names, private IPv4 (RFC 1918, loopback, link-local, CGNAT) and private IPv6, URLs with credentials or secrets, and URLs containing a `SPURHUND_REDACT` term.
  - Exa Agent `query` and `systemPrompt` pass through the same redaction as search queries.
  - The database and `$SPURHUND_HOME` are private to the user (0600 / 0700); reports and logs are 0600.
  - The Claude subprocess receives exactly one credential and never the Exa or Brave keys.
- **Cancel and reap:** `cancel_research` on a job whose worker is gone ends it as `canceled`; a job whose worker died without a cancel request becomes `failed`. A canceled or failed job still gets a partial report.
- **Report:** states `Partial result` when the job did not complete or an Exa run stopped at its budget or time limit; counts, coverage, engines, costs and gaps come from the database.
- **CLI:** `plan`, `start --approve`, `status`, `result [--full]`, `cancel`, internal `worker --job`.
- **Tests:** `bun run test` (offline, Vitest) and `bun run test:live` (opt-in, costs listed in the README). The same scripts run with npm. `bun run --bun test` runs Vitest on Bun; Bun's native test runner is not the verification gate.

### Worker isolation and request handling

- **Worker isolation:** sessions run with `strictMcpConfig: true`, and the in-process server is named `spurhund_job`, so user, project and plugin MCP servers (including the user's own `spurhund`) never load into a worker.
- **No duplicate paid runs:** `agent.runs.create` is never retried. Each create carries `metadata.spurhund_nonce`. On an ambiguous failure (timeout, 5xx, network), the run is looked up by nonce among the 25 latest and adopted; if it is not found, the worst case is charged and the user is told to check for an orphan.
- **Timeouts:** every Exa call is raced against 90 s. The published exa-js 2.25.0 has no timeout or AbortSignal option, so the socket may linger, but callers, limiter slots and the pipeline move on.
- **Job-scoped reads:** "page read" (evidence) and `verified` count only pages this job fetched (a cache hit counts, a read in another job or an ad-hoc fetch does not). `list_findings` shows read states as this job sees them.

### Privacy and lifecycle guarantees

- **Fetch inside a job** is limited to URLs a search, an Exa run or the user's own question (and notes) produced, so a fetched page cannot make Exa deliver data to an attacker's URL. The planner has no job, so it gets `search` only. The ad-hoc MCP `fetch` stays unrestricted (the calling Claude client is the user's own).
- **URL checks** work on parsed addresses: trailing dots, `*.localhost`, IPv4-mapped and NAT64 IPv6, `::`, link-local, site-local and multicast ranges, `198.18/15`, `192.0.0/24`, `224/4` and up. Redaction terms are matched against the raw, percent-decoded and Unicode (punycode) forms.
- **Queries** (search, objective, Exa Agent task) lose private URLs, private IPv4 addresses and internal host names, plus more key formats (`sk-proj-`, Stripe, Google, GitLab, `key=value`). The configured API key values themselves are always redaction terms.
- **Exa runs** end through one path: stop or cancel, read the final state (using the stop/cancel response, plus one GET when it carries no cost), and otherwise charge the worst case and record the run as `abandoned` with a gap. This covers repeated poll failures, failed cancels and runs that stay `running`.
- **Fetch cache:** a failed refetch keeps the earlier copy; a cache hit is clipped to the requested size; one fetch per canonical URL; Exa contents are matched by `id`, then by canonical URL.
- **Jobs:** worker slots are reserved atomically (`jobs.spawned_at`, schema v2 with an automatic migration from v1). Housekeeping on every entry point starts workers for queued jobs and fails jobs whose worker never claimed them within 60 s. `cancel` of a queued job is a conditional update.
- **Worker tools:** `merge_findings` only touches the session's own job; a segment's planned engines are binding for its `search` calls; `list_findings` with `only_unverified` always returns the first remaining page.
- **Output size:** one `fetch` result holds at most 100,000 characters of page text (Claude Desktop cuts at about 150,000). `structuredContent` no longer repeats page text and keeps at most two short snippets per search result.

### Live integration coverage

These integrations are covered only by opt-in live tests. Offline tests use mocks or injected SDK behavior and do not establish provider compatibility:

- Whether Exa returns `metadata` in `agent.runs.list` results (the live Agent test checks it). If not, an ambiguous create always falls back to charging the worst case.

- Real Exa and Brave responses (field names are taken from the SDK types and the Brave docs, and covered by mocks).
- A real Claude Agent SDK session with the in-process tools (the SDK is mocked offline; `SPURHUND_LIVE_CLAUDE=1` checks it).
- A complete `standard` job end to end (`SPURHUND_LIVE_JOB=1`).
- Whether the API accepts the generated planner/merge/report JSON Schemas unchanged through the SDK's `outputFormat`. `test/schema.test.ts` checks them against Anthropic's documented limits (no numeric or string constraints, `additionalProperties: false`, 7 union-typed parameters against a limit of 16, no optional parameters), so a rejection would point to something the docs do not list; simplify `worker/plan.ts` if it happens.

### Report correctness and gap resolution

- Evidence is refreshed from job-scoped successful reads (`read` or `truncated`) when findings' sources change, findings merge, verification is set, and immediately before report assembly. A later verifier fetch no longer leaves an earlier snippet label stale.
- Coverage is explicitly assessed at merge, before verification. The merge prompt must not describe verification status.
- Schema v3 migrates v1/v2 databases in place. Gaps add nullable `resolved_note` and `resolved_by_json`. Only the verify role gets `resolve_gap`; resolution requires verified findings in the same job. Reports separate open and closed gaps, retaining resolution notes and finding ids. Status/summary gap counts include only open gaps.
- Narrative output contains only `summary`, instructed to use prose, at most 250 words and finding-id citations. `keyTakeaways` is removed from the schema, JSON report, Markdown and result summary.
- Planner success criteria describe requirements, not candidate answers, figures or dates. Calibration hints belong in notes prefixed `Unverified lead:`; segment prompts require confirmation or refutation.

### Token and cost control

- Schema v3 also adds `claude_sessions(id, job_id, role, label, cost_usd, turns, subtype, duration_ms, created_at)`. The pipeline records one row per returned SDK session result alongside the existing job total. Reports aggregate role, session count, turns and estimated cost under **Claude usage by phase**. Planning sessions are deliberately not stored: they have no job and are outside the research-job usage cap.
- `SPURHUND_MAX_CLAUDE_USD_PER_JOB` defaults to `3`, must be finite and greater than zero, and limits estimated Claude usage for a job. Before each session, the pipeline subtracts accumulated usage and parallel reservations, then passes the smaller of the per-session budget and remaining allowance to SDK `maxBudgetUsd`. Parallel segments reserve shares of that allowance. Exhaustion skips later non-report sessions, records events/gaps and marks the report partial.
- Report generation always gets a minimum $0.15 allowance, even beyond the job or per-session cap. This intentional overshoot preserves a narrative for a partial job. SDK budgets are checked at model-call boundaries and use estimates, so $0.15 is not a strict bound on actual overshoot. Canceled/failed jobs still receive the deterministic report without another Claude session.
- Worker search shows the first 10 merged results, title, URL, engines, date and one snippet of at most 300 characters. Full results remain stored; user-facing search is unchanged. Worker fetch accepts at most 3 URLs, defaults to 6,000 characters per page, and still permits an explicit request up to 60,000. Findings stay at 60 per page, one claim/status line plus its sources.
- Exa 2.25.0 supports highlights with `query` and `maxCharacters`. Verify-only fetch accepts optional `claim`, requests highlights without full text and marks nonempty output `truncated`, never `read`. This counts as fetched evidence but cannot alone establish `verified`. Highlight reads bypass full-text cache reuse and store a zero full-text capacity, so later full-page verification fetches do not mistake highlights for complete content.
- Core caches successful searches per engine and canonical parameter JSON inside the worker's in-memory job Core, including in-flight duplicate calls. Cache hits make no new engine call, charge or `engine_calls` row. Failed calls are evicted. Ad-hoc search remains uncached; no TTL or DB table was added.

### Runtime limits and lifecycle

- **Concurrency and retries:** limiter release hands a slot directly to a waiter, Retry-After above 30 seconds fails immediately with the original error, and parallel execute work settles before the first fatal rejection is rethrown.
- **Reports, logs and source metadata:** report turns respect `min(SPURHUND_MAX_TURNS, 10)`, workers log only to stderr (already redirected to their per-job log), URL canonicalization preserves `ref` but strips `ref_src`, and empty stored titles/publication dates can be filled by later nonempty metadata.
- **Planning estimates:** Brave prices come from `PRICES`, and planner per-segment allowances use `DEPTH_ESTIMATES`. The planner must not invent dollar totals. Exa planning estimates add `MAX_GAP_SEARCHES × PRICES.exaSearch`, plus one maximal 25-result search and up to 10 original/extra citation reads per target finding (6 original + 4 extra). Follow-up phases can spend Exa even after Brave-only segments. These are planning allowances, not programmatic search/phase quotas; the existing Exa ledger is the hard spend control. Gap/Exa Agent findings and repeated verifier searches can exceed those allowances within that cap.
- **Source independence:** critical-source independence counts sites using a last-two-label heuristic, or last three for a two-letter TLD preceded by `co/com/org/net/gov/ac/edu`. Subdomains do not become independent confirmations. This is deliberately not a full public-suffix or organization-ownership resolver.
- **CLI cap validation:** CLI plan/start reuse the MCP numeric schema and messages, enforce at least $0.10, a $100 schema ceiling and the configured Exa maximum before auth/runtime work. Starting still cannot raise the plan's approved cap.
- **Cancellation and progress:** the external abort handler is removed in `runJob`'s `finally`; progress is throttled by the known session label, including segment id, instead of parsing the first colon out of log text.

### Offline verification

Run `bun run verify` for typechecking, offline tests and the production build. Use Node's `npx vitest run test/stdio.test.ts` for explicit CLI and protocol checks, and `bun run --bun test` to run the same Vitest suite on Bun. Tests use in-memory stores or temporary directories, fake engines and injected or scripted SDK behavior, and need no provider credentials. Live integration tests are separate and opt-in.
