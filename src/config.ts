import os from "node:os";
import path from "node:path";

export const ENGINE_IDS = ["exa", "brave"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];

/** `low` and `minimal` are deliberately not accepted anywhere. */
export const CLAUDE_EFFORTS = ["medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export type AuthMode = "oauth" | "api";

export interface Config {
  home: string;
  dbPath: string;
  reportsDir: string;
  logsDir: string;
  workDir: string;
  auth: { mode: AuthMode; oauthToken?: string; apiKey?: string };
  exaApiKey?: string;
  braveApiKey?: string;
  engines: EngineId[];
  models: { orchestrator: string; worker: string; verifier: string };
  efforts: { orchestrator: ClaudeEffort; worker: ClaudeEffort; verifier: ClaudeEffort };
  exaMaxUsdPerJob: number;
  maxTurns: number;
  maxBudgetUsd?: number;
  maxConcurrentJobs: number;
  fetchCacheDays: number;
  redact: string[];
  /** The configured secrets themselves; they are redacted from every outgoing query and URL. */
  secretValues: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid spurhund configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const DEFAULTS = {
  orchestratorModel: "claude-opus-5-5",
  workerModel: "claude-sonnet-5-5",
  orchestratorEffort: "high",
  workerEffort: "medium",
  verifierEffort: "high",
  exaMaxUsdPerJob: 5,
  maxTurns: 200,
  maxConcurrentJobs: 2,
  fetchCacheDays: 7,
} as const;

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const num = (name: string, def: number | undefined, opts: { min?: number; int?: boolean } = {}) => {
    const raw = nonEmpty(env[name]);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      problems.push(`${name} must be a number, got "${raw}"`);
      return def;
    }
    if (opts.int && !Number.isInteger(n)) problems.push(`${name} must be an integer, got "${raw}"`);
    if (opts.min !== undefined && n < opts.min) problems.push(`${name} must be >= ${opts.min}, got ${n}`);
    return n;
  };

  const effort = (name: string, def: ClaudeEffort): ClaudeEffort => {
    const raw = nonEmpty(env[name]);
    if (raw === undefined) return def;
    if ((CLAUDE_EFFORTS as readonly string[]).includes(raw)) return raw as ClaudeEffort;
    problems.push(`${name} must be one of ${CLAUDE_EFFORTS.join(", ")} ("low" is not supported), got "${raw}"`);
    return def;
  };

  const home = path.resolve(expandHome(nonEmpty(env.SPURHUND_HOME) ?? path.join(os.homedir(), ".claude", "spurhund")));

  const authRaw = nonEmpty(env.SPURHUND_AUTH) ?? "oauth";
  let mode: AuthMode = "oauth";
  if (authRaw === "oauth" || authRaw === "api") mode = authRaw;
  else problems.push(`SPURHUND_AUTH must be "oauth" or "api", got "${authRaw}"`);

  const enginesRaw = nonEmpty(env.SPURHUND_ENGINES) ?? ENGINE_IDS.join(",");
  const engines: EngineId[] = [];
  for (const e of enginesRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if ((ENGINE_IDS as readonly string[]).includes(e)) {
      if (!engines.includes(e as EngineId)) engines.push(e as EngineId);
    } else problems.push(`SPURHUND_ENGINES contains unknown engine "${e}" (known: ${ENGINE_IDS.join(", ")})`);
  }
  if (engines.length === 0) problems.push("SPURHUND_ENGINES must name at least one engine");

  const logLevelRaw = nonEmpty(env.SPURHUND_LOG_LEVEL) ?? "info";
  const logLevel = (["debug", "info", "warn", "error"] as const).find((l) => l === logLevelRaw);
  if (!logLevel) problems.push(`SPURHUND_LOG_LEVEL must be debug, info, warn or error, got "${logLevelRaw}"`);

  const workerModel = nonEmpty(env.SPURHUND_MODEL_WORKER) ?? DEFAULTS.workerModel;
  const models = {
    orchestrator: nonEmpty(env.SPURHUND_MODEL_ORCHESTRATOR) ?? DEFAULTS.orchestratorModel,
    worker: workerModel,
    verifier: nonEmpty(env.SPURHUND_MODEL_VERIFIER) ?? workerModel,
  };

  const config: Config = {
    home,
    dbPath: path.join(home, "spurhund.db"),
    reportsDir: path.join(home, "reports"),
    logsDir: path.join(home, "logs"),
    workDir: path.join(home, "work"),
    auth: { mode, oauthToken: nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN), apiKey: nonEmpty(env.ANTHROPIC_API_KEY) },
    exaApiKey: nonEmpty(env.EXA_API_KEY),
    braveApiKey: nonEmpty(env.BRAVE_API_KEY),
    engines,
    models,
    efforts: {
      orchestrator: effort("SPURHUND_EFFORT_ORCHESTRATOR", DEFAULTS.orchestratorEffort),
      worker: effort("SPURHUND_EFFORT_WORKER", DEFAULTS.workerEffort),
      verifier: effort("SPURHUND_EFFORT_VERIFIER", DEFAULTS.verifierEffort),
    },
    exaMaxUsdPerJob: num("SPURHUND_EXA_MAX_USD_PER_JOB", DEFAULTS.exaMaxUsdPerJob, { min: 0 })!,
    maxTurns: num("SPURHUND_MAX_TURNS", DEFAULTS.maxTurns, { min: 1, int: true })!,
    maxBudgetUsd: num("SPURHUND_MAX_BUDGET_USD", undefined, { min: 0 }),
    maxConcurrentJobs: num("SPURHUND_MAX_CONCURRENT_JOBS", DEFAULTS.maxConcurrentJobs, { min: 1, int: true })!,
    fetchCacheDays: num("SPURHUND_FETCH_CACHE_DAYS", DEFAULTS.fetchCacheDays, { min: 0 })!,
    redact: (nonEmpty(env.SPURHUND_REDACT) ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    secretValues: [env.EXA_API_KEY, env.BRAVE_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN, env.ANTHROPIC_API_KEY]
      .map((v) => nonEmpty(v))
      .filter((v): v is string => v !== undefined && v.length >= 8),
    logLevel: logLevel ?? "info",
  };

  if (problems.length) throw new ConfigError(problems);
  return config;
}

/** Credentials the research worker needs before it may start a Claude session. */
export function assertClaudeAuth(config: Config): void {
  if (config.auth.mode === "oauth" && !config.auth.oauthToken) {
    throw new ConfigError([
      "SPURHUND_AUTH=oauth needs CLAUDE_CODE_OAUTH_TOKEN (create one with `claude setup-token`)",
    ]);
  }
  if (config.auth.mode === "api" && !config.auth.apiKey) {
    throw new ConfigError(["SPURHUND_AUTH=api needs ANTHROPIC_API_KEY"]);
  }
}

/** Env vars that would make Claude Code pick a different credential or provider. */
const CLAUDE_CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_PROFILE",
] as const;

/** Search-engine keys the Claude subprocess must never see; the engines run in this process. */
const ENGINE_SECRET_VARS = ["EXA_API_KEY", "BRAVE_API_KEY"] as const;

/**
 * Environment for the Claude Agent SDK subprocess. Claude Code prefers
 * ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN, so exactly one credential is
 * left in place, matching SPURHUND_AUTH.
 */
export function buildClaudeEnv(config: Config, base: Env = process.env): Record<string, string> {
  assertClaudeAuth(config);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if ((CLAUDE_CREDENTIAL_VARS as readonly string[]).includes(k)) continue;
    if ((ENGINE_SECRET_VARS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  if (config.auth.mode === "oauth") out.CLAUDE_CODE_OAUTH_TOKEN = config.auth.oauthToken!;
  else out.ANTHROPIC_API_KEY = config.auth.apiKey!;
  return out;
}
