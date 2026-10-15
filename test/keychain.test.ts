import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/spurhund-keychain");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A fake `security` that serves items from a map, and an entry script that reports what it was given. */
function sandbox(items: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spurhund-kc-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const table = path.join(dir, "items.json");
  fs.writeFileSync(table, JSON.stringify(items));
  fs.writeFileSync(
    path.join(bin, "security"),
    `#!/usr/bin/env node
const items = JSON.parse(require("fs").readFileSync(${JSON.stringify(table)}, "utf8"));
const a = process.argv.slice(2);
const service = a[a.indexOf("-s") + 1];
const account = a[a.indexOf("-a") + 1];
if (a[0] !== "find-generic-password" || !a.includes("-w") || account !== "tester") process.exit(44);
if (!(service in items)) process.exit(44);
process.stdout.write(items[service] + "\\n");
`,
    { mode: 0o755 },
  );
  const entry = path.join(dir, "entry.mjs");
  fs.writeFileSync(
    entry,
    `console.log(JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(["EXA_API_KEY","BRAVE_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_API_KEY"].map((k) => [k, process.env[k] ?? null])) }));`,
  );
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync("/bin/bash", [SCRIPT, ...args], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, USER: "tester", SPURHUND_ENTRY: entry, ...env },
      encoding: "utf8",
    });
    return { ...r, json: r.stdout.trim().startsWith("{") ? JSON.parse(r.stdout) : undefined };
  };
  return { run, dir };
}

describe("scripts/spurhund-keychain", () => {
  it("is executable bash with valid syntax", () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).toBeTruthy();
    expect(() => execFileSync("bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("loads the OAuth flow's secrets from the Keychain and passes the arguments through", () => {
    const { run } = sandbox({ "spurhund-exa": "exa-secret", "spurhund-brave": "brave-secret", "spurhund-claude-oauth": "oauth-secret", "spurhund-anthropic": "api-secret" });
    const r = run(["serve", "--flag"]);
    expect(r.status).toBe(0);
    expect(r.json.argv).toEqual(["serve", "--flag"]);
    // oauth is the default: the API key is NOT loaded, so Claude Code cannot pick it over the OAuth token.
    expect(r.json.env).toEqual({ EXA_API_KEY: "exa-secret", BRAVE_API_KEY: "brave-secret", CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret", ANTHROPIC_API_KEY: null });
  });

  it("loads the API key instead in api mode", () => {
    const { run } = sandbox({ "spurhund-exa": "e", "spurhund-claude-oauth": "oauth-secret", "spurhund-anthropic": "api-secret" });
    const r = run(["serve"], { SPURHUND_AUTH: "api" });
    expect(r.json.env).toMatchObject({ ANTHROPIC_API_KEY: "api-secret", CLAUDE_CODE_OAUTH_TOKEN: null, EXA_API_KEY: "e", BRAVE_API_KEY: null });
  });

  it("lets the environment win over the Keychain", () => {
    const { run } = sandbox({ "spurhund-exa": "from-keychain" });
    expect(run(["serve"], { EXA_API_KEY: "from-env" }).json.env.EXA_API_KEY).toBe("from-env");
  });

  it("starts fine when items are missing", () => {
    const { run } = sandbox({});
    const r = run(["serve"]);
    expect(r.status).toBe(0);
    expect(r.json.env).toEqual({ EXA_API_KEY: null, BRAVE_API_KEY: null, CLAUDE_CODE_OAUTH_TOKEN: null, ANTHROPIC_API_KEY: null });
  });

  it("never prints secrets to stderr", () => {
    const { run } = sandbox({ "spurhund-exa": "super-secret-value" });
    const r = run(["serve"]);
    expect(r.stderr).not.toContain("super-secret-value");
  });

  it("explains a missing node binary", () => {
    const { run, dir } = sandbox({});
    const r = run(["serve"], { PATH: path.join(dir, "bin"), SPURHUND_NODE: "", SPURHUND_NODE_FALLBACKS: "/nonexistent/node" });
    expect(r.status).toBe(127);
    expect(r.stderr).toMatch(/node not found/);
  });

  it("falls back to a known node location when PATH has none (apps started from the Dock)", () => {
    const { run, dir } = sandbox({});
    const fakeNode = path.join(dir, "fallback-node");
    fs.writeFileSync(fakeNode, `#!/bin/sh\necho "fallback node ran: $1"\n`, { mode: 0o755 });
    const r = run(["serve"], { PATH: path.join(dir, "bin"), SPURHUND_NODE_FALLBACKS: `/nonexistent/node:${fakeNode}` });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("fallback node ran:");
  });

  it("honours SPURHUND_NODE", () => {
    const { run, dir } = sandbox({});
    const fakeNode = path.join(dir, "explicit-node");
    fs.writeFileSync(fakeNode, `#!/bin/sh\necho explicit\n`, { mode: 0o755 });
    expect(run(["serve"], { SPURHUND_NODE: fakeNode }).stdout.trim()).toBe("explicit");
  });
});
