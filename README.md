# spurhund

**spurhund** (German for "tracking hound") is a local MCP server that gives Claude better web search and a background researcher.

- **Search:** `search` asks Exa and Brave at the same time, merges the results and shows which engine found what. `fetch` reads pages and tells you honestly when a page could not be read (empty, script shell, cookie or login wall) instead of passing it off as content.
- **Research jobs:** you ask a question, spurhund proposes a plan with its worst-case cost, and after you approve, a background worker researches it. The worker uses the Claude Agent SDK on your subscription or an API key. It splits the question into parts, searches them in parallel, verifies the claims against pages it actually read and writes a sourced report. Jobs keep running when you close Claude, so they also work in Claude Desktop chat, where a single tool call times out after 240 s.

Everything runs on your machine. Data lives in SQLite under `~/.claude/spurhund/`; the only outbound calls go to Exa, Brave and Claude.

For scale: the first live `standard` job took about 2 minutes and cost $0.08 Exa, $0.05 Brave and about $0.70 of estimated Claude usage.

## How a research job works

```text
plan_research ──► you approve ──► start_research ──► worker: segments ─► merge ─► gaps ─► verify ─► report
  (plan + worst-case cost)          (returns at once)   (in parallel, plus optional Exa Agent runs)
```

1. **Plan:** a planner model splits the question into segments (sub-topics, regions, time windows, languages). The code checks the plan and its worst-case Exa cost against your cap.
2. **Research:** one Claude session per segment, up to 4 at once, each on its assigned engines. Planned Exa Agent runs go alongside.
3. **Merge:** duplicate findings are combined, and coverage is rated per segment.
4. **Gap pass** (`deep`, `exhaustive`): targeted follow-up searches where coverage is thin.
5. **Verify:** each finding is checked against a page that was read in full; critical claims need two independent sites. Gaps that a verified finding answers are closed.
6. **Report:** the model writes a short summary. Findings, sources, engine provenance, gaps and costs come straight from the database, not from the model.

| `depth`      | Segments | Gap pass | Exa Agent runs                                     |
| ------------ | -------- | -------- | -------------------------------------------------- |
| `standard`   | 1–3      | no       | up to 2, effort `medium`                           |
| `deep`       | 3–6      | yes      | `medium` or `high`                                 |
| `exhaustive` | 4–10     | yes      | up to `xhigh`, or `auto` with a budget; `ultra` only with `allow_ultra` |

## Quick start

You need:

- Node 22+ or Bun 1.4+ (both are tested)
- `EXA_API_KEY`: required (search, page reads, Exa Agent runs)
- `BRAVE_API_KEY`: optional, second search engine
- For research jobs, one Claude credential: `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (subscription, the default), or `ANTHROPIC_API_KEY` together with `SPURHUND_AUTH=api` (pay per token)

### 1. Build

```bash
cd /Users/sephyi/Development/spurhund
bun install
bun run verify   # typecheck, offline tests, build; no keys needed
```

### 2. Store the keys in the macOS Keychain

```bash
security add-generic-password -s spurhund-exa          -a "$USER" -w   # prompts for the key
security add-generic-password -s spurhund-brave        -a "$USER" -w
security add-generic-password -s spurhund-claude-oauth -a "$USER" -w   # paste the output of: claude setup-token
```

`scripts/spurhund-keychain` reads them and starts spurhund. Variables already set in the environment take precedence. Use it as the command in every client below; it also finds Node when the client was started from the Dock. To run on Bun instead, set `SPURHUND_NODE=/Users/sephyi/.bun/bin/bun`.

### 3. Connect a client

**Claude Code** (CLI and the Desktop Code tab):

```bash
claude mcp add --transport stdio --scope user spurhund -- /Users/sephyi/Development/spurhund/scripts/spurhund-keychain serve
```

**Claude Desktop chat:** Settings → Developer → Edit Config:

```json
{
  "mcpServers": {
    "spurhund": {
      "command": "/Users/sephyi/Development/spurhund/scripts/spurhund-keychain",
      "args": ["serve"]
    }
  }
}
```

Then Developer → Reload MCP Configuration.

Without the Keychain, pass the keys directly:

```bash
claude mcp add --transport stdio --env EXA_API_KEY=... --env BRAVE_API_KEY=... --scope user spurhund -- node /Users/sephyi/Development/spurhund/dist/cli.js serve
```

### 4. Use it

In Claude, just ask: "search for …", or "research … in depth". Claude shows you the plan and the cost and starts only after you agree.

From the terminal:

```bash
alias spurhund=/Users/sephyi/Development/spurhund/scripts/spurhund-keychain   # e.g. in ~/.zshrc

spurhund search "official Proxmox VE 9.0 release notes listing breaking changes" -n 10
spurhund plan "How do the major TLS libraries ship ML-KEM?" --depth deep
spurhund start plan_0123456789ab --approve
spurhund status                          # latest jobs; add a job id for details
spurhund result job_0123456789ab --full
spurhund cancel job_0123456789ab
```

## Tools

| Tool              | Does                                                              | Costs                                      |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------ |
| `search`          | Exa + Brave in parallel, merged, with the finding engine per result | about $0.01–0.03                         |
| `fetch`           | up to 10 pages, cached for 7 days, each `READ`, `TRUNCATED` or `NOT_READ` | about $0.001 per page              |
| `plan_research`   | proposes a plan and its worst-case Exa cost                       | at most $0.30 Exa for calibration searches, plus Claude usage |
| `start_research`  | starts the approved plan in the background (`approve: true`)      | up to the plan's caps                      |
| `research_status` | phase, counts, spend so far, recent events                        | nothing                                    |
| `research_result` | `summary` or `full` report, also for canceled or failed jobs      | nothing                                    |
| `cancel_research` | stops the job and its Exa runs; results so far stay readable      | nothing                                    |
| `list_jobs`       | recent jobs                                                       | nothing                                    |

Reports are also MCP resources (`spurhund://reports/<job_id>.md` and `.json`) and files in `~/.claude/spurhund/reports/`. A report contains:
- the summary;
- findings with their verification status and sources;
- coverage per segment;
- open and closed gaps;
- which engine found which sources;
- costs, including Claude usage per phase.

## Costs and limits

- **Exa: hard cap per job** (`SPURHUND_EXA_MAX_USD_PER_JOB`, default $5). Every call reserves its worst case before it runs, so parallel calls cannot overshoot. The value is also the highest cap a plan may request. If a worker crashes, the server ends its Exa Agent runs and books their cost.
- **Claude: usage cap per job** (`SPURHUND_MAX_CLAUDE_USD_PER_JOB`, default $3). When it is used up, the remaining phases are skipped and the report is marked partial. The final summary still gets $0.15. The SDK only estimates usage, so treat this as a strong brake, not a billing guarantee. Planning is not counted.
- **Brave:** not covered by the Exa cap; the plan shows the expected number of requests ($5 per 1,000, with $5 of free credit each month).
- **Subscription use:** Anthropic's terms assume Pro and Max plans are for your own, individual use of Claude Code and the Agent SDK. A service for other people needs an API key.

## Configuration

All settings are environment variables. Invalid values stop startup with a list of every problem.

| Variable                          | Default              | Meaning                                                                 |
| --------------------------------- | -------------------- | ----------------------------------------------------------------------- |
| `SPURHUND_HOME`                   | `~/.claude/spurhund` | database, `reports/`, `logs/`, `work/`                                  |
| `SPURHUND_AUTH`                   | `oauth`              | `oauth` uses `CLAUDE_CODE_OAUTH_TOKEN`, `api` uses `ANTHROPIC_API_KEY`  |
| `EXA_API_KEY` / `BRAVE_API_KEY`   |                      | engine keys                                                             |
| `SPURHUND_ENGINES`                | `exa,brave`          | engines for `search` and the worker                                     |
| `SPURHUND_MODEL_ORCHESTRATOR`     | `claude-opus-5-5`    | planning, merge, report                                                 |
| `SPURHUND_MODEL_WORKER`           | `claude-sonnet-5-5`  | segment research, gap pass                                              |
| `SPURHUND_MODEL_VERIFIER`         | worker model         | verification                                                            |
| `SPURHUND_EFFORT_ORCHESTRATOR` / `_WORKER` / `_VERIFIER` | `high` / `medium` / `high` | `medium`, `high`, `xhigh` or `max` (`low` is rejected) |
| `SPURHUND_EXA_MAX_USD_PER_JOB`    | `5`                  | hard Exa cap per job, and the highest cap a plan may ask for            |
| `SPURHUND_MAX_CLAUDE_USD_PER_JOB` | `3`                  | estimated Claude usage cap per job                                      |
| `SPURHUND_MAX_TURNS`              | `200`                | upper bound for the turn limit of each Claude session                   |
| `SPURHUND_MAX_BUDGET_USD`         | unset                | extra per-session Claude budget (Agent SDK `maxBudgetUsd`)              |
| `SPURHUND_MAX_CONCURRENT_JOBS`    | `2`                  | jobs running at once; more jobs wait                                    |
| `SPURHUND_FETCH_CACHE_DAYS`       | `7`                  | how long a fetched page is reused                                       |
| `SPURHUND_REDACT`                 | unset                | comma-separated terms (internal hosts, names) never sent anywhere       |
| `SPURHUND_LOG_LEVEL`              | `info`               | logs go to stderr and `logs/`, never to stdout                          |

To try a different model, set it in the client config, for example `SPURHUND_MODEL_WORKER=claude-haiku-5-5`.

**Credentials:** Claude Code prefers `ANTHROPIC_API_KEY` over the OAuth token when both are set. spurhund therefore gives the Claude process exactly the one credential that `SPURHUND_AUTH` selects, and never the Exa or Brave keys. Every report notes which mode ran.

## Safety

- **Nothing is spent before you approve.** `start_research` requires `approve: true` after you have seen the plan and its cost.
- **The workers are locked down.** No shell, files, web access or built-in tools. None of your skills, settings or CLAUDE.md are loaded. They can only search, fetch and record findings.
- **No citations without reading.** A finding may only cite URLs that this job found. "Page read" and `verified` are computed in code from what was actually read: `verified` needs a page read in full, and a critical claim needs two independent sites (not two subdomains of the same site).
- **Nothing private leaves the machine.** Secrets (API keys, tokens, JWTs, private keys, and your own key values), private IPs and URLs, internal host names and `SPURHUND_REDACT` terms are removed from every query. `fetch` refuses localhost, private ranges, `.local`/`.internal`/`.lan` names and URLs with credentials, because Exa's servers would fetch them.
- **Fetched pages are data, not instructions.** Inside a job, `fetch` only opens URLs that came from the job's own searches, its Exa runs or your question. A page cannot steer the worker to another server.
- Files are only written under `SPURHUND_HOME`, with mode 0600.

## Tests

```bash
bun run test         # offline tests (Vitest on Node), no keys needed
bun run --bun test   # the same Vitest suite on Bun
bun run verify       # typecheck + tests + build
bun run test:live    # opt-in live tests, see below
```

The test runner is Vitest on both runtimes, not Bun's built-in runner.

Live tests in `test/live/` are skipped unless their switch is set:

| Switch                  | Needs                          | Cost                               |
| ----------------------- | ------------------------------ | ---------------------------------- |
| `SPURHUND_LIVE=1`       | `EXA_API_KEY`, `BRAVE_API_KEY` | about $0.05                        |
| `SPURHUND_LIVE_AGENT=1` | `EXA_API_KEY`                  | $0.10                              |
| `SPURHUND_LIVE_CLAUDE=1`| Claude credential              | one tiny Haiku session             |
| `SPURHUND_LIVE_JOB=1`   | all of the above               | about $0.15 Exa plus Claude usage  |

```bash
EXA_API_KEY=... BRAVE_API_KEY=... SPURHUND_LIVE=1 bun run test:live
```

## Layout

```text
src/
  cli.ts services.ts runtime.ts jobs.ts orphans.ts   entry point, job control, crash cleanup
  core.ts merge.ts canonical.ts redact.ts            search/fetch, merging, URL rules, redaction
  config.ts costs.ts util.ts log.ts                  settings, prices and ledger, helpers
  db/{schema,store}.ts                               SQLite
  engines/{types,exa,brave}.ts                       search engines
  mcp/{server,jobTools,format}.ts                    MCP tools and output
  worker/{plan,planner,prompts,tools,runner,pipeline,report,main}.ts   research worker
scripts/spurhund-keychain                            Keychain launcher
test/                                                offline tests; test/live/ opt-in live tests
```

`SPEC.md` has the full design and every behaviour detail.

## Known limits

- Only stdio for now: no HTTP transport with OAuth, so no claude.ai connector and no Claude Desktop chat on another machine.
- The "found by only one engine" count in the report is a hint that coverage is thin, not a measure of recall.
- Exa Agent runs come only from the approved plan; the worker's Claude sessions cannot start new ones.
- Not built yet: semantic memory (`sqlite-vec`), Exa Monitors.
