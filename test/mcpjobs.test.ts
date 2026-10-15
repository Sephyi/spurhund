import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { JobController } from "../src/jobs.js";
import { createLogger } from "../src/log.js";
import { registerJobTools } from "../src/mcp/jobTools.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { Plan } from "../src/worker/plan.js";
import { formatPlan, computeWorstCase } from "../src/worker/plan.js";
import type { PlanRequest, PlanResult } from "../src/worker/planner.js";
import type { ReportJson } from "../src/worker/report.js";
import { harness } from "./helpers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const plan: Plan = {
  question: "Which Rust crates implement ML-KEM?",
  successCriteria: "A list of crates with sources",
  timeWindow: { from: null, to: null },
  languages: ["en"],
  segments: [{ id: "crates", name: "Crates", objective: "Find crates", angles: ["a"], languages: ["en"], engines: ["exa"], seedQueries: ["q"] }],
  exaRuns: [],
  notes: null,
};

async function connect(env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: "t" }) {
  const h = harness();
  const config = loadConfig({ SPURHUND_HOME: "/tmp/spurhund-mcpjobs", ...env });
  const spawnWorker = vi.fn<(id: string) => void>();
  const jobs = new JobController({ config, store: h.store, log: createLogger("error", { sink: () => {} }), spawnWorker, isAlive: () => true });
  const planCalls: PlanRequest[] = [];
  const planFn = async (req: PlanRequest): Promise<PlanResult> => {
    planCalls.push(req);
    const worstCase = computeWorstCase(plan, "standard");
    const planId = h.store.createPlan({ question: plan.question, depth: req.depth ?? "standard", plan, worstCaseUsd: worstCase.totalExaUsd, maxExaUsd: req.maxExaUsd ?? 5 });
    return { planId, plan, depth: req.depth ?? "standard", maxExaUsd: req.maxExaUsd ?? 5, worstCase, text: formatPlan(plan, "standard", worstCase, req.maxExaUsd ?? 5) };
  };
  const server = createMcpServer({ core: h.core }, (s) => registerJobTools(s, { plan: planFn, jobs, store: h.store }), { withJobs: true });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(st);
  await client.connect(ct);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }], structuredContent: undefined }));
    return { ...r, text: (r.content as { text: string }[])[0]!.text };
  };
  return { client, call, h, spawnWorker, planCalls, jobs };
}

const finishWithReport = (h: ReturnType<typeof harness>, jobId: string, over: Partial<ReportJson> = {}) => {
  h.store.claimJob(jobId, process.pid);
  const json: ReportJson = {
    jobId, state: "completed", question: plan.question, depth: "standard", partial: false, partialReason: null, summary: "Two crates implement it (#1).",
    keyTakeaways: [], findings: [{ id: 1, segment: "crates", claim: "ml-kem implements FIPS 203", verification: "verified", verificationNote: null, sourceKind: "primary", evidence: "fetched", critical: false, engines: ["exa"], publishedDate: null, sources: [{ url: "https://crates.io/crates/ml-kem", title: null, readStatus: "read" }] }],
    counts: { total: 1, verified: 1, single_source: 0, unchecked: 0, unverified: 0, contradicted: 0 }, coverage: [], gaps: [], closedGaps: [],
    engines: { sourcesTotal: 1, foundBy: { exa: 1 }, singleEngineCited: {} }, exaRuns: [],
    costs: { exaUsd: 0.1, exaByEndpoint: {}, braveUsd: 0, claudeEstimateUsd: 0.5 },
    settings: { authMode: "oauth", models: {}, efforts: { orchestrator: "high", worker: "medium", verifier: "high" }, capUsd: 5 }, startedAt: null, finishedAt: null, ...over,
  };
  h.store.saveReport(jobId, `# Report for ${jobId}\n\nbody`, json);
  h.store.finishJob(jobId, "completed");
};

describe("research job tools over MCP", () => {
  it("advertises the job workflow in the server instructions", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toMatch(/plan_research, show the user the plan and its worst-case cost, start_research only after the user approves/);
    expect(client.getInstructions()).toMatch(/Never add a language beyond English and German/);
  });

  it("declares annotations that match what each tool does", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const ann = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(ann.cancel_research).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(ann.start_research).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(ann.plan_research).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const n of ["research_status", "research_result", "list_jobs", "search", "fetch"]) expect(ann[n], n).toMatchObject({ readOnlyHint: true });
  });

  it("plan -> approve -> status -> result happy path", async () => {
    const { call, h, spawnWorker, planCalls } = await connect();

    const planned = await call("plan_research", { question: "Which Rust crates implement ML-KEM?", depth: "deep", languages: ["fr"], time_window: { from: "2026-01-01" }, max_exa_usd: 3, allow_ultra: true, notes: "n" });
    expect(planned.isError).toBeFalsy();
    expect(planCalls[0]).toEqual({ question: "Which Rust crates implement ML-KEM?", depth: "deep", languages: ["fr"], timeWindow: { from: "2026-01-01" }, maxExaUsd: 3, allowUltra: true, notes: "n" });
    expect(planned.text).toMatch(/plan_id: plan_[0-9a-f]{12}/);
    expect(planned.text).toMatch(/Worst-case Exa cost/);
    expect(planned.text).toMatch(/ask the user to approve/);
    const planId = (planned.structuredContent as { plan_id: string }).plan_id;

    const refused = await call("start_research", { plan_id: planId, approve: false });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/approve must be true/);
    expect(spawnWorker).not.toHaveBeenCalled();

    const started = await call("start_research", { plan_id: planId, approve: true, max_exa_usd: 2 });
    expect(started.isError).toBeFalsy();
    const jobId = (started.structuredContent as { job_id: string; cap_usd: number }).job_id;
    expect((started.structuredContent as { cap_usd: number }).cap_usd).toBe(2);
    expect(spawnWorker).toHaveBeenCalledWith(jobId);

    const again = await call("start_research", { plan_id: planId, approve: true });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/already started/);

    const status = await call("research_status", { job_id: jobId });
    expect(status.text).toMatch(new RegExp(`Job ${jobId}: submitted`));
    expect(status.structuredContent).toMatchObject({ job_id: jobId, state: "submitted", queue_position: 1 });

    const early = await call("research_result", { job_id: jobId });
    expect(early.isError).toBeFalsy();
    expect(early.text).toMatch(/report appears when it finishes/);

    finishWithReport(h, jobId);
    const summary = await call("research_result", { job_id: jobId });
    expect(summary.text).toContain("Two crates implement it (#1).");
    expect(summary.text).toContain("ml-kem implements FIPS 203");
    expect(summary.structuredContent).toMatchObject({ job_id: jobId, format: "summary", uri: `spurhund://reports/${jobId}.md` });
    const full = await call("research_result", { job_id: jobId, format: "full" });
    expect(full.text).toBe(`# Report for ${jobId}\n\nbody`);

    const listed = await call("list_jobs", {});
    expect(listed.text).toContain(jobId);
    expect(listed.text).toContain("completed");
    expect((listed.structuredContent as { jobs: { job_id: string }[] }).jobs[0]!.job_id).toBe(jobId);
  });

  it("explains missing credentials when starting", async () => {
    const { call, h } = await connect({});
    const planId = h.store.createPlan({ question: "q", depth: "standard", plan, worstCaseUsd: 1, maxExaUsd: 5 });
    const r = await call("start_research", { plan_id: planId, approve: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });

  it("validates job ids and plan inputs at the protocol level", async () => {
    const { call } = await connect();
    expect((await call("research_status", { job_id: "nope" })).isError).toBe(true);
    expect((await call("plan_research", { question: "short" })).isError).toBe(true);
    expect((await call("plan_research", { question: "A long enough research question", depth: "extreme" })).isError).toBe(true);
    expect((await call("plan_research", { question: "A long enough research question", max_exa_usd: 1000 })).isError).toBe(true);
    expect((await call("research_status", { job_id: "job_0123456789ab" })).text).toMatch(/Unknown job/);
    expect((await call("research_result", { job_id: "job_0123456789ab" })).isError).toBe(true);
  });

  it("cancel_research reports each case", async () => {
    const { call, h } = await connect();
    const planId = h.store.createPlan({ question: "q", depth: "standard", plan, worstCaseUsd: 1, maxExaUsd: 5 });
    const started = await call("start_research", { plan_id: planId, approve: true });
    const jobId = (started.structuredContent as { job_id: string }).job_id;
    h.store.claimJob(jobId, process.pid);
    const c = await call("cancel_research", { job_id: jobId });
    expect(c.text).toMatch(/Cancel requested/);
    expect(c.structuredContent).toMatchObject({ state: "working" });
    h.store.finishJob(jobId, "canceled");
    expect((await call("cancel_research", { job_id: jobId })).text).toBe(`Job ${jobId} already canceled.`);
  });

  it("plan errors become tool errors the model can relay", async () => {
    const h = harness();
    const jobs = new JobController({ config: loadConfig({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), store: h.store, log: createLogger("error", { sink: () => {} }), spawnWorker: () => {} });
    const server = createMcpServer({ core: h.core }, (s) => registerJobTools(s, { plan: async () => { throw new Error("The planner could not produce a valid plan after one correction."); }, jobs, store: h.store }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await server.connect(st);
    await client.connect(ct);
    closers.push(async () => { await client.close(); await server.close(); });
    const r = await client.callTool({ name: "plan_research", arguments: { question: "A long enough research question" } });
    expect(r.isError).toBe(true);
  });
});

describe("report resources", () => {
  it("lists and reads reports as Markdown and JSON, and rejects anything else", async () => {
    const { client, h } = await connect();
    const planId = h.store.createPlan({ question: "q", depth: "standard", plan, worstCaseUsd: 1, maxExaUsd: 5 });
    const jobId = h.store.createJob({ planId, authMode: "oauth", models: {}, maxExaUsd: 5 });
    expect((await client.listResources()).resources).toEqual([]);
    finishWithReport(h, jobId);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([`spurhund://reports/${jobId}.json`, `spurhund://reports/${jobId}.md`]);

    const md = await client.readResource({ uri: `spurhund://reports/${jobId}.md` });
    expect(md.contents[0]).toMatchObject({ mimeType: "text/markdown", text: `# Report for ${jobId}\n\nbody` });
    const json = await client.readResource({ uri: `spurhund://reports/${jobId}.json` });
    expect(JSON.parse((json.contents[0] as { text: string }).text).jobId).toBe(jobId);

    await expect(client.readResource({ uri: "spurhund://reports/../../etc/passwd" })).rejects.toThrow();
    await expect(client.readResource({ uri: "spurhund://reports/job_ffffffffffff.md" })).rejects.toThrow(/No report/);
    await expect(client.readResource({ uri: "spurhund://reports/notes.txt" })).rejects.toThrow(/Resource names look like/);
  });
});
