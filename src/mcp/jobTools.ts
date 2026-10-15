import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatStatus, reportUri, type JobController } from "../jobs.js";
import type { Store } from "../db/store.js";
import { DEPTHS } from "../worker/plan.js";
import type { PlanRequest, PlanResult } from "../worker/planner.js";
import { errorMessage } from "../util.js";
import { fail, ok } from "./format.js";

export interface JobServices {
  plan: (req: PlanRequest) => Promise<PlanResult>;
  jobs: JobController;
  store: Store;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const jobId = z.string().regex(/^job_[0-9a-f]{12}$/, "a job id looks like job_0123456789ab");

export const exaCapInput = (max = 100) => z.number().min(0.1).max(Math.min(max, 100)).optional();

export const planInput = z.object({
  question: z.string().min(10).max(4000).describe("The research question, with scope and what the answer will be used for."),
  depth: z.enum(DEPTHS).default("standard").describe("standard: 1-3 segments. deep: 3-6 segments, gap pass. exhaustive: 4-10 segments, larger Exa Agent runs."),
  languages: z.array(z.string().min(2).max(8)).max(5).optional().describe("Languages beyond English and German that the USER approved. Never add one on your own."),
  time_window: z.object({ from: isoDate.optional(), to: isoDate.optional() }).optional().describe("Absolute dates; relative times must be converted first."),
  max_exa_usd: exaCapInput().describe("Hard cap on Exa spend for the job. Defaults to the server setting."),
  allow_ultra: z.boolean().default(false).describe("Allow Exa Agent effort ultra (30 min to 3 h, metered). Only when the user asked for maximum depth."),
  notes: z.string().max(2000).optional(),
});

export const startInput = z.object({
  plan_id: z.string().min(1),
  approve: z.boolean().describe("Must be true. Set it only after the user has seen the plan and its worst-case cost and approved."),
  max_exa_usd: exaCapInput().describe("Lower the Exa cap below the plan's; cannot raise it."),
});

export function registerJobTools(server: McpServer, svc: JobServices): void {
  server.registerTool(
    "plan_research",
    {
      title: "Plan a research job (spends almost nothing)",
      description:
        "Step 1 of a large research job. A planner splits the question into segments, angles and languages, may add Exa Agent runs, and returns the plan with its worst-case Exa cost. " +
        "Nothing is researched yet. SHOW THE PLAN AND COST TO THE USER and wait for approval before start_research. May take one to two minutes.",
      inputSchema: planInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        const r = await svc.plan({
          question: a.question,
          depth: a.depth,
          languages: a.languages,
          timeWindow: a.time_window,
          maxExaUsd: a.max_exa_usd,
          allowUltra: a.allow_ultra,
          notes: a.notes,
        });
        return ok(`${r.text}\n\nplan_id: ${r.planId}\nTo run it, ask the user to approve, then call start_research with plan_id and approve=true.`, {
          plan_id: r.planId,
          depth: r.depth,
          max_exa_usd: r.maxExaUsd,
          worst_case: r.worstCase,
          plan: r.plan,
        });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "start_research",
    {
      title: "Start an approved research job",
      description:
        "Step 2. Starts the job for a plan the user approved. It runs in a separate process, so it keeps going if this session ends. Costs up to the plan's worst case in Exa spend plus Claude usage. " +
        "Returns a job_id immediately; poll research_status and read research_result when done.",
      inputSchema: startInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      if (a.approve !== true) return fail("Not started: approve must be true, and only after the user approved the plan and its cost.");
      try {
        const r = svc.jobs.start(a.plan_id, { maxExaUsd: a.max_exa_usd });
        const text = `Job ${r.jobId} ${r.queued ? "queued" : "started"}. Exa cap $${r.capUsd.toFixed(2)}.${r.note ? ` ${r.note}` : ""}\nCheck progress with research_status (job_id ${r.jobId}).`;
        return ok(text, { job_id: r.jobId, queued: r.queued, cap_usd: r.capUsd, note: r.note ?? null });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "research_status",
    {
      title: "Research job status",
      description: "State, phase, counts, spend and the latest events of a job. Cheap; poll every minute or two, not in a tight loop.",
      inputSchema: z.object({ job_id: jobId }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const s = svc.jobs.status(a.job_id);
      if (!s) return fail(`Unknown job ${a.job_id}.`);
      return ok(formatStatus(s), {
        job_id: s.job.id,
        state: s.job.state,
        phase: s.job.phase,
        error: s.job.error,
        elapsed_seconds: s.elapsedSeconds,
        queue_position: s.queuePosition ?? null,
        stats: s.stats,
        claude_cost_usd: s.job.claudeCostUsd,
      });
    },
  );

  server.registerTool(
    "research_result",
    {
      title: "Research job result",
      description:
        "The report of a finished job. `summary` is the answer, counts, the best findings and open gaps; `full` is the whole Markdown report (up to 100k characters). " +
        "Partial results of canceled or failed jobs are readable too. Report which findings are verified and which are not.",
      inputSchema: z.object({ job_id: jobId, format: z.enum(["summary", "full"]).default("summary") }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const r = svc.jobs.result(a.job_id, a.format);
        return r.found ? ok(r.text, { job_id: a.job_id, format: a.format, uri: reportUri(a.job_id, "md") }) : { content: [{ type: "text" as const, text: r.text }] };
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "cancel_research",
    {
      title: "Cancel a research job",
      description: "Stops a job: a running worker ends its Exa Agent runs (ultra runs keep partial results) and writes a partial report. Spend so far stays spent.",
      inputSchema: z.object({ job_id: jobId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      try {
        const r = svc.jobs.cancel(a.job_id);
        return ok(r.message, { job_id: a.job_id, state: r.state });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List research jobs",
      description: "The most recent research jobs with state, spend and question.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const rows = svc.jobs.list(a.limit);
      const text = rows.length
        ? rows.map((s) => `${s.job.id}  ${s.job.state.padEnd(9)} ${s.depth.padEnd(10)} Exa $${s.stats.exaCostUsd.toFixed(2)}  ${s.question.slice(0, 80)}`).join("\n")
        : "No jobs yet.";
      return ok(text, { jobs: rows.map((s) => ({ job_id: s.job.id, state: s.job.state, phase: s.job.phase, depth: s.depth, question: s.question, exa_cost_usd: s.stats.exaCostUsd, created_at: s.job.createdAt })) });
    },
  );

  server.registerResource(
    "report",
    new ResourceTemplate("spurhund://reports/{file}", {
      list: async () => ({
        resources: svc.store.listReportJobIds().flatMap((id) => [
          { uri: reportUri(id, "md"), name: `${id}.md`, mimeType: "text/markdown" },
          { uri: reportUri(id, "json"), name: `${id}.json`, mimeType: "application/json" },
        ]),
      }),
    }),
    { title: "Research reports", description: "Finished or partial reports of research jobs, as Markdown or JSON.", mimeType: "text/markdown" },
    async (uri, variables) => {
      const file = Array.isArray(variables.file) ? variables.file[0] : variables.file;
      const m = /^(job_[0-9a-f]{12})\.(md|json)$/.exec(file ?? "");
      if (!m) throw new Error("Resource names look like job_0123456789ab.md or .json");
      const report = svc.store.getReport(m[1]!);
      if (!report) throw new Error(`No report for ${m[1]}`);
      return m[2] === "md"
        ? { contents: [{ uri: uri.href, mimeType: "text/markdown", text: report.markdown }] }
        : { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(report.json, null, 2) }] };
    },
  );
}
