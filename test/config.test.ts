import { describe, expect, it } from "vitest";
import { ConfigError, assertClaudeAuth, buildClaudeEnv, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig({ HOME: "/h" });
    expect(c.auth.mode).toBe("oauth");
    expect(c.engines).toEqual(["exa", "brave"]);
    expect(c.models).toEqual({
      orchestrator: "claude-opus-5-5",
      worker: "claude-sonnet-5-5",
      verifier: "claude-sonnet-5-5",
    });
    expect(c.efforts).toEqual({ orchestrator: "high", worker: "medium", verifier: "high" });
    expect(c.exaMaxUsdPerJob).toBe(5);
    expect(c.maxTurns).toBe(200);
    expect(c.maxConcurrentJobs).toBe(2);
    expect(c.maxBudgetUsd).toBeUndefined();
    expect(c.home.endsWith("/.claude/spurhund")).toBe(true);
    expect(c.dbPath).toBe(`${c.home}/spurhund.db`);
  });

  it("verifier model follows the worker model unless set", () => {
    const c = loadConfig({ SPURHUND_MODEL_WORKER: "claude-haiku-5-5" });
    expect(c.models.worker).toBe("claude-haiku-5-5");
    expect(c.models.verifier).toBe("claude-haiku-5-5");
    const d = loadConfig({ SPURHUND_MODEL_WORKER: "claude-haiku-5-5", SPURHUND_MODEL_VERIFIER: "claude-sonnet-5-5" });
    expect(d.models.verifier).toBe("claude-sonnet-5-5");
  });

  it("expands ~ in SPURHUND_HOME", () => {
    const c = loadConfig({ SPURHUND_HOME: "~/custom" });
    expect(c.home.endsWith("/custom")).toBe(true);
    expect(c.home.includes("~")).toBe(false);
  });

  it("rejects low and minimal effort", () => {
    expect(() => loadConfig({ SPURHUND_EFFORT_WORKER: "low" })).toThrow(/"low" is not supported/);
    expect(() => loadConfig({ SPURHUND_EFFORT_ORCHESTRATOR: "minimal" })).toThrow(ConfigError);
  });

  it("accepts xhigh and max", () => {
    const c = loadConfig({ SPURHUND_EFFORT_ORCHESTRATOR: "max", SPURHUND_EFFORT_VERIFIER: "xhigh" });
    expect(c.efforts.orchestrator).toBe("max");
    expect(c.efforts.verifier).toBe("xhigh");
  });

  it("collects every problem in one error", () => {
    try {
      loadConfig({ SPURHUND_AUTH: "magic", SPURHUND_ENGINES: "exa,bing", SPURHUND_MAX_TURNS: "abc", SPURHUND_LOG_LEVEL: "loud" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const p = (e as ConfigError).problems.join("\n");
      expect(p).toMatch(/SPURHUND_AUTH/);
      expect(p).toMatch(/unknown engine "bing"/);
      expect(p).toMatch(/SPURHUND_MAX_TURNS/);
      expect(p).toMatch(/SPURHUND_LOG_LEVEL/);
    }
  });

  it("validates numeric bounds", () => {
    expect(() => loadConfig({ SPURHUND_MAX_CONCURRENT_JOBS: "0" })).toThrow(/>= 1/);
    expect(() => loadConfig({ SPURHUND_EXA_MAX_USD_PER_JOB: "-1" })).toThrow(/>= 0/);
    expect(() => loadConfig({ SPURHUND_MAX_TURNS: "2.5" })).toThrow(/integer/);
  });

  it("parses redact terms and ignores empty entries", () => {
    const c = loadConfig({ SPURHUND_REDACT: " corp.internal , ,Acme " });
    expect(c.redact).toEqual(["corp.internal", "Acme"]);
  });

  it("de-duplicates engines and keeps order", () => {
    const c = loadConfig({ SPURHUND_ENGINES: "brave, exa, brave" });
    expect(c.engines).toEqual(["brave", "exa"]);
  });
});

describe("Claude auth", () => {
  const base = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-api-xxxxxxxxxxxxxxxx",
    ANTHROPIC_AUTH_TOKEN: "bearer-token",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value",
    CLAUDE_CODE_USE_BEDROCK: "1",
    EXA_API_KEY: "exa-secret",
    BRAVE_API_KEY: "brave-secret",
  };

  it("oauth mode keeps only the OAuth token", () => {
    const c = loadConfig(base);
    const env = buildClaudeEnv(c, base);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token-value");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("api mode keeps only the API key", () => {
    const c = loadConfig({ ...base, SPURHUND_AUTH: "api" });
    const env = buildClaudeEnv(c, base);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api-xxxxxxxxxxxxxxxx");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("never passes the search engine keys to the Claude subprocess", () => {
    const env = buildClaudeEnv(loadConfig(base), base);
    expect(env.EXA_API_KEY).toBeUndefined();
    expect(env.BRAVE_API_KEY).toBeUndefined();
  });

  it("fails clearly when the selected credential is missing", () => {
    expect(() => assertClaudeAuth(loadConfig({ PATH: "x" }))).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(() => assertClaudeAuth(loadConfig({ SPURHUND_AUTH: "api", CLAUDE_CODE_OAUTH_TOKEN: "t" }))).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});
