import fs from "node:fs";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeEnv, type ClaudeEffort, type Config } from "../config.js";
import type { Logger } from "../log.js";
import { errorMessage } from "../util.js";
import type { Role, ToolSpec } from "./tools.js";

export interface RunRequest {
  role: Role;
  /** Short label for logs and events, e.g. "segment:vendors". */
  label: string;
  model: string;
  effort: ClaudeEffort;
  systemPrompt: string;
  prompt: string;
  tools: ToolSpec[];
  /** JSON Schema for a structured final answer. */
  outputSchema?: Record<string, unknown>;
  maxTurns: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface RunResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  /** Client-side estimate from the SDK; with a subscription this is usage, not a bill. */
  costUsd: number;
  turns: number;
  /** SDK result subtype, e.g. success, error_max_turns, error_max_budget_usd. */
  subtype: string;
  errors: string[];
}

export interface AgentRunner {
  run(req: RunRequest): Promise<RunResult>;
}

/** The three Agent SDK functions the runner uses; injectable so tests need no module mocking. */
export interface AgentSdk {
  query: typeof query;
  tool: typeof tool;
  createSdkMcpServer: typeof createSdkMcpServer;
}

const REAL_SDK: AgentSdk = { query, tool, createSdkMcpServer };

/**
 * Deliberately not "spurhund": the user registers the spurhund MCP server under that
 * name, and a collision could route a worker's tool calls to the uncapped outer server.
 */
const SERVER_NAME = "spurhund_job";
export const toolId = (name: string) => `mcp__${SERVER_NAME}__${name}`;

/**
 * Runs one locked-down Claude Code session through the Agent SDK: no built-in
 * tools, no user settings or skills, only the given tools, auto-denying
 * everything else.
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly sdk: AgentSdk = REAL_SDK,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    fs.mkdirSync(this.config.workDir, { recursive: true });
    const server = this.sdk.createSdkMcpServer({
      name: SERVER_NAME,
      version: "0.1.0",
      tools: req.tools.map((t) =>
        this.sdk.tool(
          t.name,
          t.description,
          t.shape,
          async (args: Record<string, unknown>) => {
            const out = await t.handler(args);
            return { content: [{ type: "text" as const, text: out.text }], ...(out.isError ? { isError: true } : {}) };
          },
          { annotations: { readOnlyHint: t.readOnly } },
        ),
      ),
    });

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (req.signal?.aborted) ac.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    const result: RunResult = { ok: false, text: "", costUsd: 0, turns: 0, subtype: "no_result", errors: [] };
    const q = this.sdk.query({
      prompt: req.prompt,
      options: {
        model: req.model,
        effort: req.effort,
        maxTurns: req.maxTurns,
        ...((req.maxBudgetUsd ?? this.config.maxBudgetUsd) !== undefined ? { maxBudgetUsd: req.maxBudgetUsd ?? this.config.maxBudgetUsd } : {}),
        systemPrompt: req.systemPrompt,
        mcpServers: { [SERVER_NAME]: server },
        // Only the server above: no user, project or plugin MCP servers (settingSources does not cover these).
        strictMcpConfig: true,
        tools: [],
        allowedTools: req.tools.map((t) => toolId(t.name)),
        permissionMode: "dontAsk",
        settingSources: [],
        persistSession: false,
        cwd: this.config.workDir,
        env: buildClaudeEnv(this.config),
        abortController: ac,
        stderr: (data: string) => this.log.debug(`[claude ${req.label}] ${data.trim()}`),
        ...(req.outputSchema ? { outputFormat: { type: "json_schema" as const, schema: req.outputSchema } } : {}),
      },
    });

    try {
      for await (const msg of q) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") req.onProgress?.(`${req.label}: ${String(block.name).replace(`mcp__${SERVER_NAME}__`, "")}`);
          }
        } else if (msg.type === "result") {
          result.subtype = msg.subtype;
          result.costUsd = msg.total_cost_usd ?? 0;
          result.turns = msg.num_turns ?? 0;
          if (msg.subtype === "success") {
            result.ok = !msg.is_error;
            result.text = msg.result ?? "";
            result.structured = msg.structured_output;
          } else {
            result.errors = (msg as { errors?: string[] }).errors ?? [msg.subtype];
          }
        }
      }
    } catch (err) {
      if (req.signal?.aborted) {
        result.subtype = "aborted";
        result.errors = ["aborted"];
      } else {
        result.subtype = "exception";
        result.errors = [errorMessage(err)];
        this.log.error(`Claude session ${req.label} failed: ${errorMessage(err)}`);
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      try {
        q.close();
      } catch {
        // already closed
      }
    }
    return result;
  }
}
