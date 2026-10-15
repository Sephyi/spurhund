/**
 * Live tests. Each group is skipped unless its switch and credentials are present, and says what it costs.
 *
 *   SPURHUND_LIVE=1              search + fetch against real Exa and Brave      (~$0.05)
 *   SPURHUND_LIVE_AGENT=1        one Exa Agent run at effort medium             ($0.10)
 *   SPURHUND_LIVE_CLAUDE=1       one tiny locked-down Claude session (Haiku)    (subscription or ~$0.01)
 *   SPURHUND_LIVE_JOB=1          a whole `standard` job, capped at $1 Exa       (~$0.50 Exa + Claude usage)
 *
 * Keys come from the environment: EXA_API_KEY, BRAVE_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/log.js";
import { adhocCore, buildRuntime } from "../../src/runtime.js";
import { buildServices } from "../../src/services.js";
import { ClaudeAgentRunner } from "../../src/worker/runner.js";
import { workerMain } from "../../src/worker/main.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-live-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const env = { ...process.env, SPURHUND_HOME: home };
const config = loadConfig(env);
const log = createLogger("info", { sink: (l) => process.stderr.write(l) });

const on = (flag: string) => process.env[flag] === "1";
const hasClaude = Boolean(config.auth.mode === "oauth" ? config.auth.oauthToken : config.auth.apiKey);

describe.skipIf(!on("SPURHUND_LIVE") || !config.exaApiKey || !config.braveApiKey)("live: search and fetch (Exa + Brave)", () => {
  const rt = buildRuntime(config, log);
  const core = adhocCore(rt);

  it("both engines answer and the merge records which engine found what", async () => {
    const out = await core.search({
      query: "official Proxmox VE 9.0 release notes listing breaking changes and known issues",
      objective: "Official Proxmox pages first; exclude blog reposts.",
      numResults: 8,
    });
    expect(out.engines.map((e) => [e.engine, e.ok])).toEqual([["exa", true], ["brave", true]]);
    expect(out.results.length).toBeGreaterThan(3);
    expect(out.results.every((r) => r.foundBy.length >= 1 && r.canonicalUrl.startsWith("https://"))).toBe(true);
    expect(out.costUsd).toBeGreaterThan(0);
    expect(out.costUsd).toBeLessThan(0.05);
    const both = out.results.filter((r) => r.foundBy.length === 2).length;
    console.log(`live search: ${out.results.length} results, ${both} found by both engines, $${out.costUsd.toFixed(4)}`);
  });

  it("each engine alone works", async () => {
    for (const engine of ["exa", "brave"] as const) {
      const out = await core.search({ query: "nftables named sets with timeouts wiki page", numResults: 5, engines: [engine] });
      expect(out.engines).toHaveLength(1);
      expect(out.results.length).toBeGreaterThan(0);
    }
  });

  it("a German query works and Brave honours country and language", async () => {
    const out = await core.search({ query: "BSI Empfehlung zur Zeitsynchronisation Server aktuelle Veröffentlichung", numResults: 5, country: "DE", lang: "de" });
    expect(out.results.length).toBeGreaterThan(0);
  });

  it("fetches a long document, flags truncation, then serves the cache", async () => {
    const url = "https://www.rfc-editor.org/rfc/rfc9000.html";
    const first = await core.fetch({ urls: [url], maxCharacters: 3000 });
    expect(first.pages[0]).toMatchObject({ status: "truncated", cached: false });
    expect(first.pages[0]!.text!.length).toBeGreaterThan(2000);
    const second = await core.fetch({ urls: [url], maxCharacters: 3000 });
    expect(second.pages[0]).toMatchObject({ cached: true });
    expect(second.costUsd).toBe(0);
  });

  it("reports pages that cannot be read instead of returning empty text as content", async () => {
    const out = await core.fetch({ urls: ["https://example.com/this-page-does-not-exist-404"] });
    expect(out.pages[0]!.status).toBe("not_read");
    expect(out.pages[0]!.reason).toBeTruthy();
  });

  it("refuses internal URLs without any network call", async () => {
    await expect(core.fetch({ urls: ["http://192.168.1.1/"] })).rejects.toThrow(/private IP/);
  });
});

describe.skipIf(!on("SPURHUND_LIVE_AGENT") || !config.exaApiKey)("live: Exa Agent run ($0.10)", () => {
  it("runs a medium agent to completion, reports its cost and respects the ledger", async () => {
    const rt = buildRuntime(config, log);
    const planId = rt.store.createPlan({ question: "live", depth: "standard", plan: {}, worstCaseUsd: 0.1, maxExaUsd: 0.5 });
    const jobId = rt.store.createJob({ planId, authMode: "oauth", models: {}, maxExaUsd: 0.5 });
    const { Core } = await import("../../src/core.js");
    const { CostLedger } = await import("../../src/costs.js");
    const core = new Core({ config, store: rt.store, engines: rt.engines, exa: rt.exa, jobId, ledger: new CostLedger(0.5) });
    const started = await core.agentStart("live-medium", { query: "What is the latest stable release of Proxmox VE and when was it released? Cite the official release notes.", effort: "medium" });
    let run = started;
    for (let i = 0; i < 120 && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled"; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      run = await core.agentGet(started.id);
    }
    expect(run.status).toBe("completed");
    expect(run.output?.text).toBeTruthy();
    expect(core.ledger!.spent).toBeGreaterThan(0);
    expect(core.ledger!.spent).toBeLessThanOrEqual(0.15);
    expect(rt.store.getExaRun(started.id)).toMatchObject({ status: "completed" });
    // The recovery path for a lost create response depends on Exa echoing our metadata in list results.
    const listed = (await (rt.exa as unknown as { client: { agent: { runs: { list(p: { limit: number }): Promise<{ data: { id: string; metadata?: unknown; request?: { metadata?: unknown } }[] }> } } } }).client.agent.runs.list({ limit: 25 })).data.find((r) => r.id === started.id);
    console.log("live agent: metadata echoed in list =", JSON.stringify(listed?.metadata ?? listed?.request?.metadata ?? null));
    expect(listed?.metadata ?? listed?.request?.metadata, "Exa does not echo metadata; AmbiguousCreateError recovery will always fall back to charging the worst case").toBeTruthy();
    console.log(`live agent: ${run.status}, stopReason ${run.stopReason}, $${core.ledger!.spent.toFixed(3)}`);
  });
});

describe.skipIf(!on("SPURHUND_LIVE_CLAUDE") || !hasClaude)("live: locked-down Claude session", () => {
  it("calls our tool through the in-process MCP server and cannot use anything else", async () => {
    const runner = new ClaudeAgentRunner(loadConfig({ ...env, SPURHUND_MODEL_WORKER: process.env.SPURHUND_LIVE_MODEL ?? "claude-haiku-5-5" }), log);
    let seen = "";
    const res = await runner.run({
      role: "segment",
      label: "live-claude",
      model: process.env.SPURHUND_LIVE_MODEL ?? "claude-haiku-5-5",
      effort: "medium",
      systemPrompt: "You are a test agent. Use only the tools you were given.",
      prompt: "Call the echo tool with text 'ping', then answer with exactly the tool's reply. If you have a Bash or file tool, say so.",
      tools: [
        {
          name: "echo",
          description: "Echoes the given text back.",
          shape: { text: z.string() },
          readOnly: true,
          handler: async (a) => {
            seen = String(a.text);
            return { text: `pong:${seen}` };
          },
        },
      ],
      maxTurns: 6,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(seen).toBe("ping");
    expect(res.text).toContain("pong:ping");
    expect(res.text.toLowerCase()).not.toMatch(/i have (a )?(bash|file)/);
    expect(res.costUsd).toBeGreaterThan(0);
  });
});

describe.skipIf(!on("SPURHUND_LIVE_JOB") || !hasClaude || !config.exaApiKey)("live: a whole standard job", () => {
  it("plans, runs, verifies and reports within its caps", async () => {
    const rt = buildRuntime(loadConfig({ ...env, SPURHUND_EXA_MAX_USD_PER_JOB: "1", SPURHUND_MODEL_WORKER: process.env.SPURHUND_LIVE_MODEL ?? "claude-sonnet-5-5" }), log);
    const svc = buildServices(rt, { spawnWorker: () => {} }); // the test runs the worker in-process
    const plan = await svc.plan({ question: "Which Debian release is current stable, and when did its latest point release ship?", depth: "standard", maxExaUsd: 1 });
    console.log(plan.text);
    expect(plan.worstCase.totalExaUsd).toBeLessThanOrEqual(1);

    const start = svc.jobs.start(plan.planId);
    await workerMain({ config: rt.config, store: rt.store, engines: rt.engines, exa: rt.exa, runner: svc.runner, log }, start.jobId);

    const job = rt.store.getJob(start.jobId)!;
    expect(job.state, job.error ?? "").toBe("completed");
    const report = rt.store.getReport(start.jobId)!;
    expect(report.markdown).toContain("## Findings");
    const stats = rt.store.jobStats(start.jobId);
    expect(stats.findings).toBeGreaterThan(0);
    expect(stats.exaCostUsd).toBeLessThanOrEqual(1);
    console.log(report.markdown);
  });
});
