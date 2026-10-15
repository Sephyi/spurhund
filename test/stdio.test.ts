import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

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
