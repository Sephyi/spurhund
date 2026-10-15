import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { Store, type JobRow } from "../src/db/store.js";
import { ExaEngine, type AgentRunLike } from "../src/engines/exa.js";
import { createLogger } from "../src/log.js";
import type { Depth, Plan } from "../src/worker/plan.js";
import { workerMain } from "../src/worker/main.js";
import { runJob, type PipelineDeps } from "../src/worker/pipeline.js";
import type { AgentRunner, RunRequest, RunResult } from "../src/worker/runner.js";
import { LONG_TEXT, fakeBrave, fakeExaClient, jsonResponse } from "./helpers.js";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
type Script = (req: RunRequest, call: Call, n: number) => Promise<Partial<RunResult>> | Partial<RunResult>;

class ScriptedRunner implements AgentRunner {
  readonly calls: RunRequest[] = [];
  constructor(private readonly script: Script) {}
  get roles() {
    return this.calls.map((c) => c.role);
  }
  async run(req: RunRequest): Promise<RunResult> {
    this.calls.push(req);
    const call: Call = (name, args = {}) => {
      const t = req.tools.find((x) => x.name === name);
      if (!t) throw new Error(`${req.role} has no tool ${name}`);
      return t.handler(args);
    };
    const r = await this.script(req, call, this.calls.length);
    return { ok: true, text: "", costUsd: 0.05, turns: 3, subtype: "success", errors: [], ...r };
  }
}

const seg = (id: string): Plan["segments"][number] => ({
  id,
  name: `Segment ${id}`,
  objective: `Objective of ${id}`,
  angles: ["primary sources", "criticism"],
  languages: ["en"],
  engines: ["exa", "brave"],
  seedQueries: [`documentation about ${id}`],
});

function makePlan(over: Partial<Plan> = {}): Plan {
  return {
    question: "How do TLS libraries ship ML-KEM?",
    successCriteria: "Libraries with release status and sources",
    timeWindow: { from: "2026-01-01", to: null },
    languages: ["en"],
    segments: [seg("openssl"), seg("rustls")],
    exaRuns: [],
    notes: null,
    ...over,
  };
}

interface Setup {
  deps: PipelineDeps;
  store: Store;
  job: JobRow;
  config: Config;
  exaClient: ReturnType<typeof fakeExaClient>;
  runner: ScriptedRunner;
}

function setup(opts: { depth?: Depth; plan?: Partial<Plan>; script: Script; exa?: Parameters<typeof fakeExaClient>[0]; cap?: number; brave?: Parameters<typeof fakeBrave>[0] }): Setup {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-pipe-"));
  tmpDirs.push(home);
  const config = loadConfig({ SPURHUND_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", SPURHUND_ENGINES: "exa,brave" });
  const store = Store.memory();
  const depth = opts.depth ?? "deep";
  const planId = store.createPlan({ question: "q", depth, plan: makePlan(opts.plan), worstCaseUsd: 1, maxExaUsd: opts.cap ?? 5 });
  const jobId = store.createJob({ planId, authMode: "oauth", models: { orchestrator: "o", worker: "w", verifier: "v" }, maxExaUsd: opts.cap ?? 5 });
  const job = store.claimJob(jobId, process.pid)!;
  const exaClient = fakeExaClient({
    search: (q) => ({
      results: [
        { url: `https://docs.example/${encodeURIComponent(q.slice(0, 20))}`, title: "Docs", highlights: [`exa hit for ${q}`] },
        { url: "https://shared.example/page", title: "Shared", highlights: ["shared"] },
      ],
      costDollars: { total: 0.01 },
    }),
    getContents: (urls) => ({ results: urls.map((url) => ({ url, title: "Page", text: LONG_TEXT })), costDollars: { total: 0.001 } }),
    ...opts.exa,
  });
  const exa = new ExaEngine(exaClient, { retry: { sleepFn: async () => {} } });
  const brave = fakeBrave(
    opts.brave ??
      (() =>
        jsonResponse({
          grounding: { generic: [{ url: "https://shared.example/page", title: "Shared", snippets: ["brave shared"] }, { url: "https://brave-only.example/x", title: "BraveOnly", snippets: ["only brave"] }] },
        })),
  );
  const runner = new ScriptedRunner(opts.script);
  const deps: PipelineDeps = {
    config,
    store,
    engines: { exa, brave: brave.engine },
    exa,
    runner,
    log: createLogger("error", { sink: () => {} }),
    pollMs: 1,
    cancelPollMs: 5,
    sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    now: () => new Date("2026-10-15T12:00:00Z"),
  };
  return { deps, store, job, config, exaClient, runner };
}

/** What a well-behaved model would do in each phase. */
const goodScript: Script = async (req, call) => {
  switch (req.role) {
    case "segment": {
      const seg = req.label.split(":")[1]!;
      await call("search", { query: `official documentation about ${seg} ML-KEM support`, objective: "primary sources" });
      await call("fetch", { urls: [`https://docs.example/${encodeURIComponent(`official documentation about ${seg} ML-KEM support`.slice(0, 20))}`] });
      const rec = await call("record_finding", {
        claim: `${seg} documents ML-KEM key exchange support in its changelog`,
        sources: [`https://docs.example/${encodeURIComponent(`official documentation about ${seg} ML-KEM support`.slice(0, 20))}`, "https://shared.example/page"],
        source_kind: "primary",
        critical: seg === "openssl",
      });
      expect(rec.isError).toBeUndefined();
      await call("record_gap", { description: `No ${seg} statement before 2025 found` });
      return {};
    }
    case "merge":
      return { structured: { coverage: [{ segmentId: "openssl", level: "good", note: "two primary sources" }, { segmentId: "rustls", level: "thin", note: "only docs" }], missingAreas: ["2024 history"] } };
    case "gap": {
      await call("record_gap", { description: "Pre-2025 history stays open" });
      return {};
    }
    case "verify": {
      const list = await call("list_findings", { only_unverified: true });
      for (const m of list.text.matchAll(/^#(\d+) /gm)) {
        await call("set_verification", { finding_id: Number(m[1]), status: "verified", note: "page states it", extra_sources: [] });
      }
      return {};
    }
    case "report":
      return { structured: { summary: "Both libraries document ML-KEM support (#1, #2).", keyTakeaways: ["OpenSSL documents it (#1)"] } };
    default:
      return {};
  }
};

describe("runJob: happy path (deep)", () => {
  it("runs every phase in order and produces a complete report", async () => {
    const s = setup({ script: goodScript });
    const outcome = await runJob(s.deps, s.job);
    expect(outcome).toBe("completed");

    // Phases: segments in parallel, then merge, gap pass (deep), verify, report.
    expect(s.runner.roles.slice(0, 2).sort()).toEqual(["segment", "segment"]);
    expect(s.runner.roles.slice(2)).toEqual(["merge", "gap", "verify", "report"]);

    // Models and effort come from the role: orchestrator for plan-level work, worker for research, verifier for checks.
    const byRole = (r: string) => s.runner.calls.find((c) => c.role === r)!;
    expect(byRole("segment")).toMatchObject({ model: s.config.models.worker, effort: "medium" });
    expect(byRole("merge")).toMatchObject({ model: s.config.models.orchestrator, effort: "high" });
    expect(byRole("verify")).toMatchObject({ model: s.config.models.verifier, effort: "high" });
    expect(byRole("report")).toMatchObject({ model: s.config.models.orchestrator });
    expect(byRole("merge").outputSchema).toBeDefined();
    expect(byRole("segment").outputSchema).toBeUndefined();

    // Every session got the shared rules and a turn cap.
    for (const c of s.runner.calls) {
      expect(c.systemPrompt).toContain("Prefer primary sources");
      expect(c.systemPrompt).toContain("Approved languages: en");
      expect(c.systemPrompt).toContain("Today is 2026-10-15");
      expect(c.maxTurns).toBeLessThanOrEqual(s.config.maxTurns);
    }

    const job = s.store.getJob(s.job.id)!;
    expect(job.state).toBe("completed");
    expect(job.finishedAt).not.toBeNull();
    expect(job.claudeCostUsd).toBeCloseTo(0.05 * 6);

    const findings = s.store.listFindings(job.id);
    expect(findings).toHaveLength(2);
    // rustls: one read page is enough. openssl is critical and cites two hosts, but only docs.example was read
    // (shared.example was only searched), so the guardrail downgrades the model's "verified".
    const openssl = findings.find((f) => f.segment === "openssl")!;
    const rustls = findings.find((f) => f.segment === "rustls")!;
    expect(openssl.critical).toBe(true);
    expect(openssl.verification).toBe("single_source");
    expect(openssl.verificationNote).toMatch(/critical claim needs two independent hosts that were read, found 1/);
    expect(rustls.verification).toBe("verified");
    expect(s.store.listEvents(job.id, 100).map((e) => e.phase)).toEqual(expect.arrayContaining(["execute", "merge", "gap", "verify", "report", "done"]));
  });

  it("stores a report with provenance, counts, gaps and costs, and writes it to disk", async () => {
    const s = setup({ script: goodScript });
    await runJob(s.deps, s.job);
    const report = s.store.getReport(s.job.id)!;
    const json = report.json as import("../src/worker/report.js").ReportJson;

    expect(json).toMatchObject({ state: "completed", partial: false, depth: "deep", summary: "Both libraries document ML-KEM support (#1, #2)." });
    expect(json.counts).toMatchObject({ total: 2, verified: 1, single_source: 1 });
    expect(json.coverage.map((c) => [c.segmentId, c.level, c.findings])).toEqual([["openssl", "good", 1], ["rustls", "thin", 1]]);
    expect(json.gaps.map((g) => g.description)).toContain("Pre-2025 history stays open");
    expect(json.settings).toMatchObject({ authMode: "oauth", capUsd: 5 });
    expect(json.costs.exaUsd).toBeGreaterThan(0);
    expect(json.costs.braveUsd).toBeCloseTo(0.005 * json.engines.foundBy.brave!, 5);
    // Both engines surfaced the shared page; docs.example is Exa-only.
    expect(json.engines.foundBy).toMatchObject({ exa: expect.any(Number), brave: expect.any(Number) });
    expect(json.engines.singleEngineCited.exa).toBeGreaterThanOrEqual(1);
    const f = json.findings[0]!;
    expect(f.engines.sort()).toEqual(["brave", "exa"]);
    expect(f.sources.map((x) => x.url)).toContain("https://shared.example/page");

    const md = report.markdown;
    expect(md).toContain("# Research report: How do TLS libraries ship ML-KEM?");
    expect(md).toContain("## Findings");
    expect(md).toMatch(/\*\*#1\*\*/);
    expect(md).toContain("Best-effort result");
    expect(md).not.toMatch(/complete list|definitive|exhaustive result/i);
    expect(md).toContain("| Segment | Assessment | Findings | Note |");
    expect(md).toContain("Cited sources found by only one engine");
    expect(md).toMatch(/Claude: about \$0\.\d+ by the SDK's client-side estimate \(subscription usage, not a bill\)/);

    expect(fs.readFileSync(path.join(s.config.reportsDir, `${s.job.id}.md`), "utf8")).toBe(md);
    expect(JSON.parse(fs.readFileSync(path.join(s.config.reportsDir, `${s.job.id}.json`), "utf8")).jobId).toBe(s.job.id);
    if (process.platform !== "win32") expect(fs.statSync(path.join(s.config.reportsDir, `${s.job.id}.md`)).mode & 0o777).toBe(0o600);
  });

  it("standard depth skips the gap pass", async () => {
    const s = setup({ depth: "standard", script: goodScript });
    await runJob(s.deps, s.job);
    expect(s.runner.roles).not.toContain("gap");
    expect(s.runner.roles.slice(-3)).toEqual(["merge", "verify", "report"]);
  });

  it("uses the engines assigned to each segment's tools (both engines in one search call)", async () => {
    const s = setup({ script: goodScript });
    await runJob(s.deps, s.job);
    expect(s.exaClient.search).toHaveBeenCalled();
    const hits = s.store.enginesBySource(s.job.id);
    expect([...hits.values()].some((e) => e.includes("brave") && e.includes("exa"))).toBe(true);
  });
});

describe("runJob: Exa Agent runs", () => {
  const withRun = (over: Partial<Plan["exaRuns"][number]> = {}): Partial<Plan> => ({
    exaRuns: [{ id: "crates", segmentIds: [], query: "List ML-KEM crates", systemPrompt: null, effort: "high", budgetUsd: null, maxDurationSeconds: null, outputSchemaJson: null, ...over }],
  });
  const completed = (extra: Partial<AgentRunLike> = {}): AgentRunLike => ({
    id: "run_1",
    status: "completed",
    stopReason: "schema_satisfied",
    output: { text: "Two crates", structured: { crates: ["ml-kem"] }, grounding: [{ field: "crates.0", citations: [{ url: "https://crates.io/crates/ml-kem" }] }] },
    costDollars: { total: 0.42 },
    ...extra,
  });

  it("starts the run in parallel with the segments, polls it and lets the merge step cite its pages", async () => {
    let polls = 0;
    const s = setup({
      plan: withRun(),
      exa: { create: () => ({ id: "run_1", status: "running" }), get: (id) => (++polls < 3 ? { id, status: "running" } : completed()) },
      script: async (req, call, n) => {
        if (req.role === "merge") {
          const out = await call("exa_run_output", { run_id: "crates" });
          expect(out.text).toContain("Two crates");
          const rec = await call("record_finding", { claim: "The ml-kem crate implements FIPS 203 KEM", sources: ["https://crates.io/crates/ml-kem"], source_kind: "primary" });
          expect(rec.isError).toBeUndefined();
          return { structured: { coverage: [], missingAreas: [] } };
        }
        return goodScript(req, call, n);
      },
    });
    expect(await runJob(s.deps, s.job)).toBe("completed");
    expect(s.exaClient.agent.runs.create).toHaveBeenCalledWith({ query: "List ML-KEM crates", effort: "high", metadata: { spurhund_nonce: expect.any(String) } });
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(s.store.getExaRun("run_1")).toMatchObject({ status: "completed", costUsd: 0.42, planRunId: "crates" });
    const json = s.store.getReport(s.job.id)!.json as import("../src/worker/report.js").ReportJson;
    expect(json.exaRuns).toEqual([{ id: "crates", effort: "high", status: "completed", stopReason: "schema_satisfied", costUsd: 0.42 }]);
    expect(json.costs.exaByEndpoint.agent).toBeCloseTo(0.42);
    expect(json.findings.some((f) => f.segment === "exa-agent")).toBe(true);
    expect(json.partial).toBe(false);
  });

  it("marks the result partial when a run stops at its budget", async () => {
    const s = setup({
      plan: withRun({ effort: "auto", budgetUsd: 3 }),
      depth: "exhaustive",
      exa: { create: () => ({ id: "run_1", status: "running" }), get: () => completed({ stopReason: "budget_reached", costDollars: { total: 3 } }) },
      script: goodScript,
    });
    await runJob(s.deps, s.job);
    expect(s.exaClient.agent.runs.create).toHaveBeenCalledWith({ query: "List ML-KEM crates", effort: "auto", budget: { maxCostDollars: 3 }, metadata: { spurhund_nonce: expect.any(String) } });
    const json = s.store.getReport(s.job.id)!.json as import("../src/worker/report.js").ReportJson;
    expect(json.partial).toBe(true);
    expect(json.partialReason).toMatch(/budget or time limit/);
    expect(json.gaps.map((g) => g.description).join()).toMatch(/stopped at its budget limit/);
    expect(s.store.getReport(s.job.id)!.markdown).toContain("**Partial result:**");
  });

  it("keeps going when a run cannot be started and records the gap", async () => {
    const s = setup({ plan: withRun(), exa: { create: () => { throw new Error("400 invalid outputSchema"); } }, script: goodScript });
    expect(await runJob(s.deps, s.job)).toBe("completed");
    expect(s.store.listGaps(s.job.id).map((g) => g.description).join()).toMatch(/Exa run crates could not be completed \(400 invalid outputSchema\)/);
  });

  it("records a failed run as a gap", async () => {
    const s = setup({ plan: withRun(), exa: { create: () => ({ id: "run_1", status: "running" }), get: (id) => ({ id, status: "failed", error: { message: "schema rejected" } }) }, script: goodScript });
    await runJob(s.deps, s.job);
    expect(s.store.listGaps(s.job.id).map((g) => g.description).join()).toMatch(/ended with status failed: schema rejected/);
    expect(s.store.getExaRun("run_1")!.status).toBe("failed");
  });

  it("never lets the job exceed its Exa cap: an unaffordable run is skipped with a gap", async () => {
    const s = setup({ plan: withRun({ effort: "xhigh" }), cap: 0.5, script: goodScript });
    await runJob(s.deps, s.job);
    expect(s.exaClient.agent.runs.create).not.toHaveBeenCalled();
    expect(s.store.listGaps(s.job.id).map((g) => g.description).join()).toMatch(/budget/);
  });
});

describe("runJob: failures and cancellation", () => {
  it("a failing segment session is a gap, not a failed job", async () => {
    const s = setup({
      script: async (req, call, n) => (req.label === "segment:rustls" ? { ok: false, subtype: "error_max_turns", errors: ["too many turns"] } : goodScript(req, call, n)),
    });
    expect(await runJob(s.deps, s.job)).toBe("completed");
    expect(s.store.listGaps(s.job.id).map((g) => g.description)).toContain("The research session for this segment ended early (error_max_turns); coverage here may be thin.");
    expect(s.store.listFindings(s.job.id)).toHaveLength(1);
  });

  it("findings the verifier did not reach are reported unverified, never silently fine", async () => {
    const s = setup({ script: async (req, call, n) => (req.role === "verify" ? {} : goodScript(req, call, n)) });
    await runJob(s.deps, s.job);
    const f = s.store.listFindings(s.job.id);
    expect(f.every((x) => x.verification === "unverified")).toBe(true);
    expect(f[0]!.verificationNote).toBe("Not checked in the verification pass.");
    expect((s.store.getReport(s.job.id)!.json as import("../src/worker/report.js").ReportJson).counts.unverified).toBe(2);
  });

  it("a job without findings skips merge, gap and verify and says so", async () => {
    const s = setup({ script: async (req) => (req.role === "report" ? { structured: { summary: "Nothing found.", keyTakeaways: [] } } : {}) });
    expect(await runJob(s.deps, s.job)).toBe("completed");
    expect(s.runner.roles.filter((r) => r !== "segment")).toEqual(["report"]);
    expect(s.store.getReport(s.job.id)!.markdown).toContain("_No findings were recorded._");
  });

  it("a planner-independent crash in the pipeline marks the job failed but still writes a partial report", async () => {
    const s = setup({ script: async (req, call, n) => { if (req.role === "merge") throw new Error("runner exploded"); return goodScript(req, call, n); } });
    expect(await runJob(s.deps, s.job)).toBe("failed");
    const job = s.store.getJob(s.job.id)!;
    expect(job).toMatchObject({ state: "failed", error: "runner exploded" });
    const report = s.store.getReport(s.job.id)!;
    expect((report.json as import("../src/worker/report.js").ReportJson).partial).toBe(true);
    expect(report.markdown).toContain("the job failed: runner exploded");
  });

  it("a cancel request aborts running sessions, ends Exa runs and keeps a partial report", async () => {
    let cancelled = false;
    const s = setup({
      depth: "exhaustive",
      cap: 10,
      plan: { exaRuns: [{ id: "deep-run", segmentIds: [], query: "Find everything", systemPrompt: null, effort: "ultra", budgetUsd: 8, maxDurationSeconds: 1800, outputSchemaJson: null }] },
      exa: { create: () => ({ id: "run_u", status: "running" }), get: (id) => (cancelled ? { id, status: "completed", stopReason: "stopped", output: { text: "partial" }, costDollars: { total: 1.2 } } : { id, status: "running" }) },
      script: async (req, call) => {
        if (req.role === "segment") {
          await call("search", { query: "something to find" });
          // Block like a long model session until the job is aborted.
          await new Promise<void>((resolve) => req.signal!.addEventListener("abort", () => resolve(), { once: true }));
          return { ok: false, subtype: "aborted", errors: ["aborted"] };
        }
        throw new Error(`unexpected phase ${req.role}`);
      },
    });
    const done = runJob(s.deps, s.job);
    await new Promise((r) => setTimeout(r, 60));
    s.exaClient.agent.runs.stop.mockImplementation(async (id: string) => {
      cancelled = true;
      return { id, status: "completed" as const, stopReason: "stopped" };
    });
    s.store.requestCancel(s.job.id);
    expect(await done).toBe("canceled");

    expect(s.exaClient.agent.runs.stop).toHaveBeenCalledWith("run_u"); // ultra is stopped, not cancelled
    expect(s.exaClient.agent.runs.cancel).not.toHaveBeenCalled();
    expect(s.runner.roles.filter((r) => r !== "segment")).toEqual([]);
    expect(s.store.getJob(s.job.id)!.state).toBe("canceled");
    expect(s.store.getExaRun("run_u")).toMatchObject({ status: "completed", costUsd: 1.2 });
    const md = s.store.getReport(s.job.id)!.markdown;
    expect(md).toContain("the job was canceled");
    expect(md).toContain("Partial result");
  });

  it("an external abort signal (SIGTERM) cancels the job the same way", async () => {
    const ac = new AbortController();
    const s = setup({
      script: async (req) => {
        await new Promise<void>((resolve) => req.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false, subtype: "aborted", errors: ["aborted"] };
      },
    });
    s.deps.signal = ac.signal;
    const done = runJob(s.deps, s.job);
    setTimeout(() => ac.abort(), 30);
    expect(await done).toBe("canceled");
    expect(s.store.getJob(s.job.id)!.state).toBe("canceled");
  });

  it("cancelling does not charge a failed/aborted segment as a gap", async () => {
    const s = setup({
      script: async (req) => {
        await new Promise<void>((resolve) => req.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false, subtype: "aborted", errors: ["aborted"] };
      },
    });
    const done = runJob(s.deps, s.job);
    setTimeout(() => s.store.requestCancel(s.job.id), 20);
    await done;
    expect(s.store.listGaps(s.job.id)).toEqual([]);
  });
});

describe("workerMain", () => {
  function twoJobs() {
    const s = setup({ depth: "standard", script: async (req) => (req.role === "report" ? { structured: { summary: "ok", keyTakeaways: [] } } : {}) });
    // setup() already claimed job 1; release it back to "submitted" and add a second one.
    const store = s.store;
    const mk = () => {
      const p = store.createPlan({ question: "q", depth: "standard", plan: makePlan(), worstCaseUsd: 1, maxExaUsd: 5 });
      return store.createJob({ planId: p, authMode: "oauth", models: {}, maxExaUsd: 5 });
    };
    return { s, a: mk(), b: mk() };
  }

  it("runs the requested job and then keeps taking submitted jobs until none are left", async () => {
    const { s, a, b } = twoJobs();
    const ran = await workerMain(s.deps, a);
    expect(ran).toBe(2);
    expect(s.store.getJob(a)!.state).toBe("completed");
    expect(s.store.getJob(b)!.state).toBe("completed");
    expect(s.store.getJob(a)!.pid).toBe(process.pid);
  });

  it("falls back to the next waiting job when the requested one is already taken", async () => {
    const { s, a, b } = twoJobs();
    s.store.claimJob(a, 12345); // another worker owns it
    const ran = await workerMain(s.deps, a);
    expect(ran).toBe(1);
    expect(s.store.getJob(b)!.state).toBe("completed");
    expect(s.store.getJob(a)!.state).toBe("working");
  });

  it("stops after the current job when told to stop", async () => {
    const { s, a, b } = twoJobs();
    const ac = new AbortController();
    s.deps.signal = ac.signal;
    ac.abort();
    const ran = await workerMain(s.deps, a);
    expect(ran).toBe(1);
    expect(s.store.getJob(a)!.state).toBe("canceled");
    expect(s.store.getJob(b)!.state).toBe("submitted");
  });
});
