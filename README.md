# spurhund

Multi-engine web research for Claude, as an MCP server.

- **`search` / `fetch`**: one call queries Exa and Brave in parallel, merges and de-duplicates the results, and records which engine found what. Pages are read through Exa with a local cache; empty pages, script shells and walls are reported as `NOT_READ` instead of being passed off as content.
- **Research jobs**: `plan_research` → you approve the plan and its worst-case cost → `start_research`. A detached worker (Claude Agent SDK) researches segments in parallel, can run Exa Agent runs next to them, merges, closes gaps, verifies claims and writes a report with per-engine provenance and costs. Jobs survive closing Claude, and they work in Claude Desktop chat, whose tool calls time out after 240 s.

Status: first version. The unit and protocol tests pass; the live tests (real Exa, Brave and Claude) have not been run yet, see [Live tests](#live-tests).

## Requirements

- Node 20+ or Bun 1.4+ as the runtime (both are tested; the examples use Bun as the package manager, `npm` works the same)
- `EXA_API_KEY` (required for fetch, Exa Agent runs and Exa search)
- `BRAVE_API_KEY` (optional; without it Brave is disabled)
- For research jobs, one Claude credential:
  - `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (default, uses your subscription), or
  - `ANTHROPIC_API_KEY` with `SPURHUND_AUTH=api` (billed per token)

## Install

```bash
cd /Users/sephyi/Development/spurhund
bun install
bun run build
bun run test        # offline tests (vitest), no keys needed
```

The lockfile is `bun.lock`; `npm install` / `npm run build` / `npm test` work too.

### Keep keys out of config files (macOS)

```bash
security add-generic-password -s spurhund-exa          -a "$USER" -w   # prompts for the secret
security add-generic-password -s spurhund-brave        -a "$USER" -w
security add-generic-password -s spurhund-claude-oauth -a "$USER" -w   # paste the output of: claude setup-token
```

`scripts/spurhund-keychain` reads these and starts spurhund. Environment variables that are already set win over the Keychain. Because the script also finds Node when an app was started from the Dock, use it as the command for every client below. It runs Node by default; to run spurhund on Bun instead, set `SPURHUND_NODE` to Bun's path (for example `SPURHUND_NODE=/Users/sephyi/.bun/bin/bun`).

### Claude Code (CLI and the Desktop Code tab)

```bash
claude mcp add --transport stdio --scope user spurhund -- /Users/sephyi/Development/spurhund/scripts/spurhund-keychain serve
```

Without the Keychain wrapper:

```bash
claude mcp add --transport stdio --env EXA_API_KEY=... --env BRAVE_API_KEY=... --scope user spurhund -- node /Users/sephyi/Development/spurhund/dist/cli.js serve
```

### Claude Desktop (Chat)

Settings → Developer → Edit Config, then add:

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

Reload via Developer → Reload MCP Configuration. Desktop chat cancels a tool call after 240 s and caps a result at about 150,000 characters; spurhund's job tools are built for that (start, poll, read).

### From the terminal

```bash
alias spurhund=/Users/sephyi/Development/spurhund/scripts/spurhund-keychain   # e.g. in ~/.zshrc

spurhund search "official Proxmox VE 9.0 release notes listing breaking changes" -n 10
spurhund plan "How do the major TLS libraries ship ML-KEM?" --depth deep
spurhund start plan_0123456789ab --approve
spurhund status            # latest jobs; add a job id for details
spurhund result job_0123456789ab [--full]
spurhund cancel job_0123456789ab
```

## Tools

| Tool | Does | Spends |
| --- | --- | --- |
| `search` | Exa + Brave, merged, with `foundBy` per result | a few cents |
| `fetch` | up to 10 pages, cached, `READ` / `TRUNCATED` / `NOT_READ` | about $0.001 per page |
| `plan_research` | planner session returns segments, languages, Exa runs and the worst-case Exa cost | little (calibration searches are capped at $0.30) plus Claude usage |
| `start_research` | needs `approve: true`; starts the detached worker | up to the plan's worst case |
| `research_status` | state, phase, counts, spend, last events | nothing |
| `research_result` | `summary` or `full` report; partial reports of canceled or failed jobs too | nothing |
| `cancel_research` | stops the job, ends Exa runs (ultra keeps partial results) | nothing |
| `list_jobs` | recent jobs | nothing |

Reports are also MCP resources: `spurhund://reports/<job_id>.md` and `.json`, and files in `$SPURHUND_HOME/reports/`.

### What a job does

1. **Plan** (`plan_research`, orchestrator model): segments, angles, languages, engines, optional Exa Agent runs. The code validates the plan (segment counts per depth, approved languages only, effort and budget rules, worst-case cost against the cap) and sends it back for one correction if it fails.
2. **Execute** (worker model, in parallel): one Claude session per segment (up to 4 at once) plus the planned Exa Agent runs. Every segment runs its core queries on every assigned engine.
3. **Merge** (orchestrator): reads the Exa runs, records findings from them, merges duplicates, rates coverage per segment.
4. **Gap pass** (`deep` and `exhaustive`): targeted follow-up searches for thin segments and missing areas.
5. **Verify** (verifier model): fetches only what nobody read in full, looks for an independent second source for critical claims. Anything it did not reach is reported `unverified`.
6. **Report**: the model writes the summary; counts, sources, engines, gaps, Exa runs and costs are assembled from the database, not by the model.

| `depth` | Segments | Exa Agent runs | Gap pass |
| --- | --- | --- | --- |
| `standard` | 1–3 | up to 2, effort `medium` | no |
| `deep` | 3–6 | `medium` or `high` | yes |
| `exhaustive` | 4–10 | up to `xhigh`, or `auto` with a cap; `ultra` only with `allow_ultra` | yes |

## Configuration

All settings are environment variables. Invalid values stop startup with a message that lists every problem.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPURHUND_HOME` | `~/.claude/spurhund` | `spurhund.db`, `reports/`, `logs/`, `work/` |
| `SPURHUND_AUTH` | `oauth` | `oauth` uses `CLAUDE_CODE_OAUTH_TOKEN`, `api` uses `ANTHROPIC_API_KEY` |
| `EXA_API_KEY` / `BRAVE_API_KEY` | | engine keys |
| `SPURHUND_ENGINES` | `exa,brave` | engines used by `search` and the worker |
| `SPURHUND_MODEL_ORCHESTRATOR` | `claude-opus-5-5` | planning, merge, report |
| `SPURHUND_MODEL_WORKER` | `claude-sonnet-5-5` | segment research and the gap pass |
| `SPURHUND_MODEL_VERIFIER` | worker model | verification |
| `SPURHUND_EFFORT_ORCHESTRATOR` / `_WORKER` / `_VERIFIER` | `high` / `medium` / `high` | `medium`, `high`, `xhigh` or `max`. `low` is rejected |
| `SPURHUND_EXA_MAX_USD_PER_JOB` | `5` | hard Exa cap per job, enforced by a ledger that reserves worst-case amounts before each call |
| `SPURHUND_MAX_TURNS` | `200` | upper bound for the per-session turn limits |
| `SPURHUND_MAX_BUDGET_USD` | unset | Agent SDK `maxBudgetUsd` per session. A client-side estimate; with `oauth` it limits usage, not a bill |
| `SPURHUND_MAX_CONCURRENT_JOBS` | `2` | parallel worker processes; more jobs wait |
| `SPURHUND_FETCH_CACHE_DAYS` | `7` | how long a fetched page is reused |
| `SPURHUND_REDACT` | unset | comma-separated terms (internal hostnames, names) removed from every outgoing query and refused in fetched URLs |
| `SPURHUND_LOG_LEVEL` | `info` | logs go to stderr and `logs/`, never to stdout |

To try another model, set the variable in the client config, for example `SPURHUND_MODEL_WORKER=claude-haiku-5-5`.

**Billing and the two credentials.** Claude Code prefers `ANTHROPIC_API_KEY` over `CLAUDE_CODE_OAUTH_TOKEN` when both are set. spurhund therefore hands the Claude subprocess exactly one credential, chosen by `SPURHUND_AUTH`, and never passes it `EXA_API_KEY` or `BRAVE_API_KEY`. Every report records which mode ran. Anthropic's terms say Pro and Max limits assume ordinary, individual use of Claude Code and the Agent SDK, so keep subscription mode for your own use; building a service for others needs an API key.

## Safety model

- **No spending before approval.** `start_research` needs `approve: true` and the tool description tells the model to show you the plan and its worst-case cost first.
- **Hard Exa cap.** Parallel calls cannot overshoot: each call reserves its worst case and settles with the reported cost. `auto` and `ultra` always carry a budget.
- **Locked-down workers.** The Claude sessions have no Bash, file, web or other built-in tools, load none of your skills, settings or CLAUDE.md, and run with unlisted tools denied. They can only search, fetch, and record findings.
- **Findings cannot cite what was not seen.** A URL must have come from a search, a fetch or an Exa run in the same job, and "page read" is computed from what was actually read.
- **`verified` is earned in code.** It needs a page read in full; a critical claim needs two independent hosts that were read. Otherwise the status is downgraded and the note says why.
- **Queries and URLs are cleaned before leaving the machine.** Secrets (API keys, tokens, private keys, JWTs, and your configured key values themselves), private URLs and IPs, internal host names and `SPURHUND_REDACT` terms are removed from queries and Exa Agent task text. `fetch` refuses localhost, private IP ranges, `.local`/`.internal`/`.lan` names, credentials in URLs and redacted terms, because Exa's servers would receive them.
- **Fetched text is data.** Prompts say so, and the tool set makes harmful actions impossible. Inside a job, `fetch` only opens URLs that the job's searches, its Exa runs or your own question produced, so a page cannot make the worker send your question to someone else's server.
- Files are written only under `SPURHUND_HOME` (mode 0600).

## Tests

```bash
bun run test         # offline (vitest under Node): unit, store, engines (mocked), pipeline (scripted Claude), MCP over memory and real stdio
bun run typecheck
bun run verify       # typecheck, tests, build
bun run test:live    # skipped unless enabled; see below
```

### Live tests

`test/live/live.live.ts` is skipped unless the switch and credentials are present:

| Switch | Needs | Cost |
| --- | --- | --- |
| `SPURHUND_LIVE=1` | `EXA_API_KEY`, `BRAVE_API_KEY` | about $0.05 |
| `SPURHUND_LIVE_AGENT=1` | `EXA_API_KEY` | $0.10 |
| `SPURHUND_LIVE_CLAUDE=1` | Claude credential | usage of one tiny Haiku session |
| `SPURHUND_LIVE_JOB=1` | all of the above | about $0.50 Exa plus Claude usage |

```bash
EXA_API_KEY=... BRAVE_API_KEY=... SPURHUND_LIVE=1 bun run test:live
```

The test runner is vitest. Bun's own runner (`bun test`) passes the offline suite as well, but the configs and the live tests are written for vitest.

## Layout

```text
src/
  config.ts costs.ts redact.ts canonical.ts merge.ts util.ts log.ts runtime.ts services.ts jobs.ts core.ts cli.ts
  db/{schema,store}.ts
  engines/{types,exa,brave}.ts
  worker/{plan,prompts,tools,runner,planner,pipeline,report,main}.ts
  mcp/{server,jobTools,format}.ts
scripts/spurhund-keychain
test/            offline tests;  test/live/  opt-in live tests
```

## Known limits

- The report's "found by only one engine" counts are an indicator of thin coverage, not a measure of recall.
- Exa Agent runs are started by the worker from the approved plan; the model sessions cannot start them.
- Brave is not capped by the Exa budget; the plan shows its estimated request count.
- Not implemented yet: HTTP transport with OAuth (needed for Claude Desktop Chat on another machine and for claude.ai), semantic memory (`sqlite-vec`), Exa Monitors, an A2A facade.
