#!/usr/bin/env node
import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigError, ENGINE_IDS, assertClaudeAuth, loadConfig, type EngineId } from "./config.js";
import { formatStatus } from "./jobs.js";
import { createLogger } from "./log.js";
import { registerJobTools } from "./mcp/jobTools.js";
import { formatSearch } from "./mcp/format.js";
import { createMcpServer, SERVER_VERSION } from "./mcp/server.js";
import { adhocCore, buildRuntime } from "./runtime.js";
import { buildServices } from "./services.js";
import { errorMessage } from "./util.js";
import { DEPTHS, type Depth } from "./worker/plan.js";
import { workerMain } from "./worker/main.js";

const HELP = `spurhund ${SERVER_VERSION}: multi-engine research (Exa + Brave) as an MCP server

Usage:
  spurhund serve                          Run the MCP server on stdio
  spurhund search "<query>" [options]     One merged search from the terminal
      -n, --num <1-25>      results (default 10)
      -e, --engines <list>  comma list of ${ENGINE_IDS.join(",")}
      -o, --objective <t>   goal of the search (Exa)
      --json                machine-readable output

  spurhund plan "<question>" [options]    Plan a research job (nothing is researched yet)
      -d, --depth <${DEPTHS.join("|")}>
      -l, --lang <list>     extra approved languages, e.g. fr,es (English and German are always allowed)
      --from <YYYY-MM-DD> --to <YYYY-MM-DD>
      --max-exa <usd>       Exa cap for the job
      --allow-ultra         allow Exa Agent effort ultra
      --notes <text>        --json
  spurhund start <plan_id> --approve      Start the planned job in a background worker
      --max-exa <usd>       lower the cap
  spurhund status [job_id]                Progress of a job, or the latest jobs
  spurhund result <job_id> [--full]       The report
  spurhund cancel <job_id>
  spurhund help

Configuration is read from environment variables; see README.md.
`;

function parseEngines(raw: string | undefined): EngineId[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const e of list) {
    if (!(ENGINE_IDS as readonly string[]).includes(e)) throw new Error(`Unknown engine "${e}" (known: ${ENGINE_IDS.join(", ")})`);
  }
  return list as EngineId[];
}

const num = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
};

async function main(argv: string[]): Promise<number> {
  const [command = "help", ...rest] = argv;

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const config = loadConfig();
  const log = createLogger(config.logLevel, { dir: command === "worker" ? undefined : config.logsDir, name: command === "serve" ? "server" : command });
  const out = (s: string) => process.stdout.write(`${s}\n`);

  switch (command) {
    case "serve": {
      const rt = buildRuntime(config, log);
      const core = adhocCore(rt);
      const svc = buildServices(rt);
      const handle = serveStdio(() =>
        createMcpServer({ core }, (s) => registerJobTools(s, { plan: svc.plan, jobs: svc.jobs, store: rt.store }), { withJobs: true }),
      );
      log.info(`spurhund ${SERVER_VERSION} serving on stdio (engines: ${core.availableEngines().join(", ") || "none"}; auth: ${config.auth.mode})`);
      const shutdown = async () => {
        await handle.close().catch(() => {});
        rt.store.close();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return new Promise<number>(() => {}); // runs until the client closes stdin or a signal arrives
    }

    case "search": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          num: { type: "string", short: "n" },
          engines: { type: "string", short: "e" },
          objective: { type: "string", short: "o" },
          json: { type: "boolean" },
        },
      });
      const query = positionals.join(" ").trim();
      if (!query) throw new Error('Give a query: spurhund search "<query>"');
      const rt = buildRuntime(config, log);
      try {
        const res = await adhocCore(rt).search({
          query,
          objective: values.objective,
          numResults: num(values.num, "--num"),
          engines: parseEngines(values.engines),
        });
        if (values.json) out(JSON.stringify({ ...res, results: res.results.map(({ sourceId: _s, ...r }) => r) }, null, 2));
        else out(formatSearch(res));
      } finally {
        rt.store.close();
      }
      return 0;
    }

    case "plan": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          depth: { type: "string", short: "d" },
          lang: { type: "string", short: "l" },
          from: { type: "string" },
          to: { type: "string" },
          "max-exa": { type: "string" },
          "allow-ultra": { type: "boolean" },
          notes: { type: "string" },
          json: { type: "boolean" },
        },
      });
      const question = positionals.join(" ").trim();
      if (!question) throw new Error('Give a question: spurhund plan "<question>"');
      const depth = (values.depth ?? "standard") as Depth;
      if (!DEPTHS.includes(depth)) throw new Error(`--depth must be one of ${DEPTHS.join(", ")}`);
      assertClaudeAuth(config);
      const rt = buildRuntime(config, log);
      try {
        const r = await buildServices(rt).plan({
          question,
          depth,
          languages: values.lang?.split(",").map((s) => s.trim()).filter(Boolean),
          timeWindow: values.from || values.to ? { from: values.from, to: values.to } : undefined,
          maxExaUsd: num(values["max-exa"], "--max-exa"),
          allowUltra: values["allow-ultra"],
          notes: values.notes,
        });
        if (values.json) out(JSON.stringify({ plan_id: r.planId, worst_case: r.worstCase, plan: r.plan }, null, 2));
        else out(`${r.text}\n\nplan_id: ${r.planId}\nStart it with: spurhund start ${r.planId} --approve`);
      } finally {
        rt.store.close();
      }
      return 0;
    }

    case "start": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { approve: { type: "boolean" }, "max-exa": { type: "string" } },
      });
      const planId = positionals[0];
      if (!planId) throw new Error("Give a plan id: spurhund start <plan_id> --approve");
      if (!values.approve) throw new Error("Refusing to start without --approve. Read the plan and its worst-case cost first.");
      const rt = buildRuntime(config, log);
      try {
        const r = buildServices(rt).jobs.start(planId, { maxExaUsd: num(values["max-exa"], "--max-exa") });
        out(`Job ${r.jobId} ${r.queued ? "queued" : "started"}. Exa cap $${r.capUsd.toFixed(2)}.${r.note ? ` ${r.note}` : ""}\nCheck it with: spurhund status ${r.jobId}`);
      } finally {
        rt.store.close();
      }
      return 0;
    }

    case "status": {
      const rt = buildRuntime(config, log);
      try {
        const jobs = buildServices(rt).jobs;
        const id = rest[0];
        if (id) {
          const s = jobs.status(id);
          if (!s) throw new Error(`Unknown job ${id}`);
          out(formatStatus(s));
        } else {
          const rows = jobs.list(10);
          out(rows.length ? rows.map((s) => `${s.job.id}  ${s.job.state.padEnd(9)} ${s.depth.padEnd(10)} Exa $${s.stats.exaCostUsd.toFixed(2)}  ${s.question.slice(0, 70)}`).join("\n") : "No jobs yet.");
        }
      } finally {
        rt.store.close();
      }
      return 0;
    }

    case "result": {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { full: { type: "boolean" } } });
      const id = positionals[0];
      if (!id) throw new Error("Give a job id: spurhund result <job_id>");
      const rt = buildRuntime(config, log);
      try {
        out(buildServices(rt).jobs.result(id, values.full ? "full" : "summary").text);
      } finally {
        rt.store.close();
      }
      return 0;
    }

    case "cancel": {
      const id = rest[0];
      if (!id) throw new Error("Give a job id: spurhund cancel <job_id>");
      const rt = buildRuntime(config, log);
      try {
        out(buildServices(rt).jobs.cancel(id).message);
      } finally {
        rt.store.close();
      }
      return 0;
    }

    case "worker": {
      const { values } = parseArgs({ args: rest, options: { job: { type: "string" } } });
      assertClaudeAuth(config);
      const rt = buildRuntime(config, log);
      const ac = new AbortController();
      process.on("SIGTERM", () => ac.abort());
      process.on("SIGINT", () => ac.abort());
      try {
        const svc = buildServices(rt);
        await workerMain({ config, store: rt.store, engines: rt.engines, exa: rt.exa, runner: svc.runner, log, signal: ac.signal }, values.job);
      } finally {
        rt.store.close();
      }
      return 0;
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exit(code);
  },
  (err) => {
    process.stderr.write(`${err instanceof ConfigError ? err.message : errorMessage(err)}\n`);
    process.exit(1);
  },
);
