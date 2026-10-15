import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { planInput } from "../src/mcp/jobTools.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.ts");
// Bun runs TypeScript directly; Node (vitest) needs the tsx loader.
const LAUNCH = process.versions.bun ? [CLI] : ["--import", "tsx", CLI];

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function startServer(extraEnv: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-e2e-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...LAUNCH, "serve"],
    // No API keys on purpose: the server must still boot and explain itself.
    env: { PATH: process.env.PATH ?? "", HOME: home, SPURHUND_HOME: home, ...extraEnv },
    stderr: "pipe",
  });
  const stderr: string[] = [];
  transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(transport);
  cleanup.push(async () => {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { client, home, stderr };
}

describe("spurhund serve (real stdio process)", () => {
  it.each(["plan", "start"])("%s rejects invalid Exa caps before opening the runtime", (command) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-cli-cap-"));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    for (const value of ["0", "-1", "NaN", "Infinity", "0.01", "4", "101"]) {
      const parsed = planInput.safeParse({ question: "Offline cap validation", max_exa_usd: Number(value) });
      const message = Number(value) > 3 && Number.isFinite(Number(value))
        ? "Too big: expected number to be <=3"
        : parsed.success ? "unexpected valid input" : parsed.error.issues[0]!.message;
      const child = spawnSync(process.execPath, [...LAUNCH, command, "offline-placeholder", "--approve", `--max-exa=${value}`].filter((arg) => command === "start" || arg !== "--approve"), {
        env: { PATH: process.env.PATH ?? "", HOME: home, SPURHUND_HOME: home, SPURHUND_EXA_MAX_USD_PER_JOB: "3" },
        encoding: "utf8", timeout: 10_000,
      });
      expect(child.status, `${command} ${value}`).toBe(1);
      expect(child.stderr, `${command} ${value}`).toContain(`--max-exa: ${message}`);
      expect(fs.existsSync(path.join(home, "spurhund.db"))).toBe(false);
    }
  });

  it.each(["plan", "start"])("%s accepts the lower and configured upper cap boundaries", (command) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-cli-cap-boundary-"));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    for (const value of ["0.1", "3"]) {
      const child = spawnSync(process.execPath, [...LAUNCH, command, "offline-placeholder", "--approve", `--max-exa=${value}`].filter((arg) => command === "start" || arg !== "--approve"), {
        env: { PATH: process.env.PATH ?? "", HOME: home, SPURHUND_HOME: home, SPURHUND_EXA_MAX_USD_PER_JOB: "3" },
        encoding: "utf8", timeout: 10_000,
      });
      expect(child.status).toBe(1);
      expect(child.stderr).not.toContain("--max-exa:");
      expect(child.stderr).toMatch(command === "plan" ? /CLAUDE_CODE_OAUTH_TOKEN/ : /Unknown plan/);
    }
  });

  it("worker startup logs to stderr without creating a second worker.log", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-worker-log-"));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [...LAUNCH, "worker", "--job", "job_000000000000"], {
      env: { PATH: process.env.PATH ?? "", HOME: home, SPURHUND_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "fake-offline-token" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toContain("EXA_API_KEY is not set");
    expect(fs.existsSync(path.join(home, "logs", "worker.log"))).toBe(false);
  });

  it("boots without API keys, lists its tools and explains what is missing", async () => {
    const { client, home, stderr } = await startServer();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_research", "fetch", "list_jobs", "plan_research", "research_result", "research_status", "search", "start_research",
    ]);
    for (const t of tools) {
      expect(t.annotations, t.name).toHaveProperty("readOnlyHint");
      expect(t.annotations, t.name).toHaveProperty("destructiveHint");
    }

    const res = await client.callTool({ name: "search", arguments: { query: "anything" } });
    expect(res.isError).toBe(true);
    const msg = (res.content as { text: string }[])[0]!.text;
    expect(msg).toMatch(/No search engine is available/);
    expect(msg).toMatch(/EXA_API_KEY/);

    const fetched = await client.callTool({ name: "fetch", arguments: { urls: ["https://example.com"] } });
    expect(fetched.isError).toBe(true);
    expect((fetched.content as { text: string }[])[0]!.text).toMatch(/needs Exa/);

    // Job tools explain what is missing instead of crashing.
    const plan = await client.callTool({ name: "plan_research", arguments: { question: "How do vendors handle ML-KEM in TLS libraries?" } });
    expect(plan.isError).toBe(true);
    expect((plan.content as { text: string }[])[0]!.text).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);

    const start = await client.callTool({ name: "start_research", arguments: { plan_id: "plan_x", approve: false } });
    expect(start.isError).toBe(true);
    expect((start.content as { text: string }[])[0]!.text).toMatch(/approve must be true/);

    const jobs = await client.callTool({ name: "list_jobs", arguments: {} });
    expect((jobs.content as { text: string }[])[0]!.text).toBe("No jobs yet.");

    const resources = await client.listResources();
    expect(resources.resources).toEqual([]);
    expect((await client.listResourceTemplates()).resourceTemplates[0]!.uriTemplate).toBe("spurhund://reports/{file}");

    expect(stderr.join("")).toMatch(/serving on stdio \(engines: none; auth: oauth\)/);
    expect(stderr.join("")).toMatch(/EXA_API_KEY is not set/);
    expect(fs.existsSync(path.join(home, "spurhund.db"))).toBe(true); // database created in SPURHUND_HOME only
  });

  it("refuses to start on an invalid configuration with a readable message", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-e2e-bad-"));
    cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [...LAUNCH, "serve"],
      env: { PATH: process.env.PATH ?? "", HOME: home, SPURHUND_HOME: home, SPURHUND_EFFORT_WORKER: "low" },
      stderr: "pipe",
    });
    const err: string[] = [];
    transport.stderr?.on("data", (d: Buffer) => err.push(d.toString()));
    const client = new Client({ name: "e2e", version: "0" });
    await expect(client.connect(transport)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(err.join("")).toMatch(/SPURHUND_EFFORT_WORKER must be one of/);
  });
});
