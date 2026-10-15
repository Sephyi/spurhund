import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import type { ToolSpec } from "../src/worker/tools.js";
import { ClaudeAgentRunner, toolId, type AgentSdk } from "../src/worker/runner.js";

// The Agent SDK spawns a real Claude Code process, so a fake SDK is injected. What is tested is
// exactly what spurhund hands to the SDK and how it maps the SDK's messages back.
const sdk = {
  queryCalls: [] as { prompt: string; options: Record<string, unknown> }[],
  messages: [] as Record<string, unknown>[],
  throwWith: undefined as Error | undefined,
  closed: 0,
  toolDefs: [] as { name: string; description: string; shape: unknown; handler: (a: Record<string, unknown>) => Promise<unknown>; extras?: unknown }[],
};

const fakeSdk = {
  tool: (name: string, description: string, shape: unknown, handler: (a: Record<string, unknown>) => Promise<unknown>, extras?: unknown) => {
    const def = { name, description, shape, handler, extras };
    sdk.toolDefs.push(def);
    return def;
  },
  createSdkMcpServer: (opts: { name: string; tools: unknown[] }) => ({ type: "sdk", name: opts.name, instance: { tools: opts.tools } }),
  query: (params: { prompt: string; options: Record<string, unknown> }) => {
    sdk.queryCalls.push(params);
    const gen = (async function* () {
      if (sdk.throwWith) throw sdk.throwWith;
      for (const m of sdk.messages) yield m;
    })();
    return Object.assign(gen, { close: () => void sdk.closed++ });
  },
} as unknown as AgentSdk;

const dirs: string[] = [];
function runner(env: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-runner-"));
  dirs.push(home);
  const config = loadConfig({ SPURHUND_HOME: home, CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", ...env });
  return { r: new ClaudeAgentRunner(config, createLogger("error", { sink: () => {} }), fakeSdk), config };
}

const echoTool: ToolSpec = {
  name: "echo",
  description: "Echoes",
  shape: { text: z.string() },
  readOnly: true,
  handler: async (a) => ({ text: `echo ${String(a.text)}` }),
};
const failingTool: ToolSpec = { ...echoTool, name: "boom", readOnly: false, handler: async () => ({ text: "nope", isError: true }) };

const baseReq = {
  role: "segment" as const,
  label: "segment:x",
  model: "claude-sonnet-5-5",
  effort: "medium" as const,
  systemPrompt: "SYSTEM",
  prompt: "do the thing",
  tools: [echoTool, failingTool],
  maxTurns: 40,
};

beforeEach(() => {
  sdk.queryCalls.length = 0;
  sdk.toolDefs.length = 0;
  sdk.messages = [{ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.42, num_turns: 7 }];
  sdk.throwWith = undefined;
  sdk.closed = 0;
});
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("ClaudeAgentRunner: what the SDK is asked to do", () => {
  it("runs a locked-down session: no built-in tools, no user settings, only our tools, everything else denied", async () => {
    const { r, config } = runner();
    await r.run(baseReq);
    const { prompt, options: o } = sdk.queryCalls[0]!;
    expect(prompt).toBe("do the thing");
    expect(o).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "medium",
      maxTurns: 40,
      systemPrompt: "SYSTEM",
      tools: [],
      allowedTools: [toolId("echo"), toolId("boom")],
      permissionMode: "dontAsk",
      settingSources: [],
      persistSession: false,
      strictMcpConfig: true,
      cwd: config.workDir,
    });
    // Not "spurhund": that name belongs to the user's registered server.
    expect(toolId("echo")).toBe("mcp__spurhund_job__echo");
    expect(Object.keys(o.mcpServers as object)).toEqual(["spurhund_job"]);
    expect(o.abortController).toBeInstanceOf(AbortController);
    expect(o).not.toHaveProperty("outputFormat");
    expect(o).not.toHaveProperty("maxBudgetUsd");
    expect(fs.existsSync(config.workDir)).toBe(true);
  });

  it("passes exactly one Claude credential and no search-engine keys to the subprocess", async () => {
    const prev = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    process.env.EXA_API_KEY = "exa-should-not-leak";
    process.env.BRAVE_API_KEY = "brave-should-not-leak";
    try {
      const { r } = runner();
      await r.run(baseReq);
      const env = sdk.queryCalls[0]!.options.env as Record<string, string>;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.EXA_API_KEY).toBeUndefined();
      expect(env.BRAVE_API_KEY).toBeUndefined();
      expect(env.PATH).toBeDefined();

      const api = runner({ SPURHUND_AUTH: "api", ANTHROPIC_API_KEY: "sk-ant-real" });
      await api.r.run(baseReq);
      const env2 = sdk.queryCalls[1]!.options.env as Record<string, string>;
      expect(env2.ANTHROPIC_API_KEY).toBe("sk-ant-real");
      expect(env2.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      for (const k of ["ANTHROPIC_API_KEY", "EXA_API_KEY", "BRAVE_API_KEY"]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  it("requests structured output only when a schema is given, and applies a configured budget", async () => {
    const { r } = runner({ SPURHUND_MAX_BUDGET_USD: "3.5" });
    await r.run({ ...baseReq, outputSchema: { type: "object", properties: { a: { type: "string" } } } });
    expect(sdk.queryCalls[0]!.options).toMatchObject({ outputFormat: { type: "json_schema", schema: { type: "object" } }, maxBudgetUsd: 3.5 });
  });

  it("fails before starting a session without credentials", async () => {
    const { r } = runner({ CLAUDE_CODE_OAUTH_TOKEN: "" });
    await expect(r.run(baseReq)).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(sdk.queryCalls).toHaveLength(0);
  });
});

describe("ClaudeAgentRunner: tools handed to the model", () => {
  it("wraps each tool with its schema, a read-only annotation and a text result", async () => {
    const { r } = runner();
    await r.run(baseReq);
    const [echo, boom] = sdk.toolDefs;
    expect(echo).toMatchObject({ name: "echo", description: "Echoes", extras: { annotations: { readOnlyHint: true } } });
    expect(boom!.extras).toEqual({ annotations: { readOnlyHint: false } });
    expect(await echo!.handler({ text: "hi" })).toEqual({ content: [{ type: "text", text: "echo hi" }] });
    expect(await boom!.handler({})).toEqual({ content: [{ type: "text", text: "nope" }], isError: true });
  });
});

describe("ClaudeAgentRunner: result mapping", () => {
  it("maps a successful result", async () => {
    const { r } = runner();
    sdk.messages = [
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }, { type: "tool_use", name: "mcp__spurhund_job__search" }] } },
      { type: "result", subtype: "success", is_error: false, result: "final text", structured_output: { ok: 1 }, total_cost_usd: 0.42, num_turns: 7 },
    ];
    const progress: string[] = [];
    const res = await r.run({ ...baseReq, onProgress: (m) => progress.push(m) });
    expect(res).toEqual({ ok: true, text: "final text", structured: { ok: 1 }, costUsd: 0.42, turns: 7, subtype: "success", errors: [] });
    expect(progress).toEqual(["segment:x: search"]);
    expect(sdk.closed).toBe(1);
  });

  it("maps error subtypes and keeps the cost spent so far", async () => {
    const { r } = runner();
    sdk.messages = [{ type: "result", subtype: "error_max_turns", errors: ["Reached maximum number of turns (40)"], total_cost_usd: 1.1, num_turns: 40 }];
    expect(await r.run(baseReq)).toMatchObject({ ok: false, subtype: "error_max_turns", errors: ["Reached maximum number of turns (40)"], costUsd: 1.1, turns: 40 });
    sdk.messages = [{ type: "result", subtype: "success", is_error: true, result: "API error", total_cost_usd: 0, num_turns: 1 }];
    expect((await r.run(baseReq)).ok).toBe(false);
  });

  it("reports a session that produced no result", async () => {
    const { r } = runner();
    sdk.messages = [];
    expect(await r.run(baseReq)).toMatchObject({ ok: false, subtype: "no_result" });
  });

  it("turns an SDK exception into a failed result instead of throwing", async () => {
    const { r } = runner();
    sdk.throwWith = new Error("claude binary not found");
    const res = await r.run(baseReq);
    expect(res).toMatchObject({ ok: false, subtype: "exception", errors: ["claude binary not found"] });
    expect(sdk.closed).toBe(1);
  });

  it("an abort signal aborts the SDK session and is reported as aborted, not as an error", async () => {
    const { r } = runner();
    const ac = new AbortController();
    sdk.throwWith = new Error("The operation was aborted");
    ac.abort();
    const res = await r.run({ ...baseReq, signal: ac.signal });
    expect(res).toMatchObject({ ok: false, subtype: "aborted", errors: ["aborted"] });
    expect((sdk.queryCalls[0]!.options.abortController as AbortController).signal.aborted).toBe(true);
  });

  it("forwards a later abort to the SDK's abort controller", async () => {
    const { r } = runner();
    const ac = new AbortController();
    sdk.messages = [{ type: "result", subtype: "success", is_error: false, result: "x", total_cost_usd: 0, num_turns: 1 }];
    await r.run({ ...baseReq, signal: ac.signal });
    expect((sdk.queryCalls[0]!.options.abortController as AbortController).signal.aborted).toBe(false);
  });
});
