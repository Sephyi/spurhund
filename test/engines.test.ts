import { describe, expect, it } from "vitest";
import { BraveEngine, braveFreshness } from "../src/engines/brave.js";
import { ExaEngine, classifyPage } from "../src/engines/exa.js";
import { BRAVE_PAYLOAD, LONG_TEXT, fakeBrave, fakeExaClient, jsonResponse } from "./helpers.js";

const noSleep = { retry: { sleepFn: async () => {} } };

describe("ExaEngine.search", () => {
  it("maps results, highlights and ranks, and uses the reported cost", async () => {
    const client = fakeExaClient({
      search: () => ({
        results: [
          { url: "https://a.com/1", title: "A", publishedDate: "2026-09-01", highlights: ["h1", "h2"] },
          { url: "https://b.com/2", title: null, text: "x".repeat(1000) },
        ],
        costDollars: { total: 0.0123 },
      }),
    });
    const out = await new ExaEngine(client, noSleep).search({ text: "q", numResults: 2 });
    expect(out.costUsd).toBe(0.0123);
    expect(out.endpoint).toBe("search");
    expect(out.results[0]).toEqual({ url: "https://a.com/1", title: "A", publishedDate: "2026-09-01", snippets: ["h1", "h2"], engine: "exa", rank: 1 });
    expect(out.results[1]).toMatchObject({ title: "", rank: 2, engine: "exa" });
    expect(out.results[1]!.snippets[0]).toHaveLength(600);
  });

  it("sends type auto, highlights, objective, dates and an upper-case country", async () => {
    const client = fakeExaClient();
    await new ExaEngine(client, noSleep).search({ text: "q", objective: "goal", numResults: 7, country: "de", from: "2026-01-01", to: "2026-06-30" });
    expect(client.search).toHaveBeenCalledWith("q", {
      type: "auto",
      numResults: 7,
      contents: { highlights: true },
      objective: "goal",
      startPublishedDate: "2026-01-01",
      endPublishedDate: "2026-06-30",
      userLocation: "DE",
    });
  });

  it("omits optional fields and falls back to an estimate without a reported cost", async () => {
    const client = fakeExaClient();
    const e = new ExaEngine(client, noSleep);
    const out = await e.search({ text: "q", numResults: 3 });
    expect(client.search).toHaveBeenCalledWith("q", { type: "auto", numResults: 3, contents: { highlights: true } });
    expect(out.costUsd).toBeCloseTo(0.007 + 3 * 0.001);
  });

  it("retries a 429 from exa-js (statusCode) and gives up on 401", async () => {
    let n = 0;
    const flaky = fakeExaClient({
      search: () => {
        if (++n < 2) throw Object.assign(new Error("rate limited"), { statusCode: 429 });
        return { results: [] };
      },
    });
    await expect(new ExaEngine(flaky, noSleep).search({ text: "q", numResults: 1 })).resolves.toBeDefined();
    expect(flaky.search).toHaveBeenCalledTimes(2);

    const denied = fakeExaClient({
      search: () => {
        throw Object.assign(new Error("bad key"), { statusCode: 401 });
      },
    });
    await expect(new ExaEngine(denied, noSleep).search({ text: "q", numResults: 1 })).rejects.toThrow("bad key");
    expect(denied.search).toHaveBeenCalledTimes(1);
  });
});

describe("classifyPage", () => {
  it("flags empty and tiny pages as not read", () => {
    expect(classifyPage("", 3000)).toMatchObject({ status: "not_read", reason: "empty page" });
    expect(classifyPage(undefined, 3000).status).toBe("not_read");
    expect(classifyPage("tiny", 3000)).toMatchObject({ status: "not_read" });
  });

  it("flags cookie and bot walls but not long pages that merely mention cookies", () => {
    const wall = "Please enable cookies to continue. ".repeat(10);
    expect(classifyPage(wall, 3000)).toMatchObject({ status: "not_read", reason: "cookie, login or bot wall" });
    const article = ("We use enable javascript examples here. " + "Real article content. ".repeat(100));
    expect(classifyPage(article, 5000).status).toBe("read");
  });

  it("marks text that fills the limit as truncated", () => {
    expect(classifyPage("a".repeat(3000), 3000).status).toBe("truncated");
    expect(classifyPage("a".repeat(2999), 3000).status).toBe("read");
  });
});

describe("ExaEngine.fetch", () => {
  it("returns pages in request order with per-URL status", async () => {
    const client = fakeExaClient({
      getContents: () => ({
        results: [
          { url: "https://ok.com", title: "OK", publishedDate: "2026-05-05", text: LONG_TEXT },
          { url: "https://wall.com", text: "Please enable cookies to continue. ".repeat(10) },
        ],
        statuses: [
          { id: "https://ok.com", status: "success" },
          { id: "https://wall.com", status: "success" },
          { id: "https://gone.com", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
        ],
        costDollars: { total: 0.003 },
      }),
    });
    const out = await new ExaEngine(client, noSleep).fetch(["https://gone.com", "https://ok.com", "https://wall.com", "https://missing.com"], 12_000);
    expect(client.getContents).toHaveBeenCalledWith(["https://gone.com", "https://ok.com", "https://wall.com", "https://missing.com"], { text: { maxCharacters: 12_000 } });
    expect(out.costUsd).toBe(0.003);
    expect(out.pages.map((p) => [p.url, p.status])).toEqual([
      ["https://gone.com", "not_read"],
      ["https://ok.com", "read"],
      ["https://wall.com", "not_read"],
      ["https://missing.com", "not_read"],
    ]);
    expect(out.pages[0]!.reason).toBe("fetch failed: CRAWL_NOT_FOUND");
    expect(out.pages[1]).toMatchObject({ title: "OK", publishedDate: "2026-05-05" });
    expect(out.pages[3]!.reason).toBe("no content returned");
  });
});

describe("ExaEngine agent runs", () => {
  it("sends a metered budget for ultra including the duration", async () => {
    const client = fakeExaClient();
    await new ExaEngine(client, noSleep).agentCreate({
      query: "find all", effort: "ultra", budgetUsd: 12, maxDurationSeconds: 1800,
      systemPrompt: "sp", outputSchema: { type: "object" }, previousRunId: "run_0", exclusion: [{ name: "x" }],
    });
    expect(client.agent.runs.create).toHaveBeenCalledWith({
      query: "find all", effort: "ultra", systemPrompt: "sp", outputSchema: { type: "object" }, previousRunId: "run_0",
      input: { exclusion: [{ name: "x" }] }, budget: { maxCostDollars: 12, maxDurationSeconds: 1800 },
      metadata: { spurhund_nonce: expect.any(String) },
    });
  });

  it("sends no budget for fixed efforts", async () => {
    const client = fakeExaClient();
    await new ExaEngine(client, noSleep).agentCreate({ query: "q", effort: "high" });
    expect(client.agent.runs.create).toHaveBeenCalledWith({ query: "q", effort: "high", metadata: { spurhund_nonce: expect.any(String) } });
  });

  it("rejects invalid effort and budget combinations before any request", async () => {
    const client = fakeExaClient();
    const e = new ExaEngine(client, noSleep);
    await expect(e.agentCreate({ query: "q", effort: "low" as never })).rejects.toThrow(/not allowed/);
    await expect(e.agentCreate({ query: "q", effort: "auto" })).rejects.toThrow(/needs a budget/);
    await expect(e.agentCreate({ query: "q", effort: "ultra" })).rejects.toThrow(/needs a budget/);
    await expect(e.agentCreate({ query: "q", effort: "high", budgetUsd: 3 })).rejects.toThrow(/fixed price/);
    await expect(e.agentCreate({ query: "q", effort: "auto", budgetUsd: 3, maxDurationSeconds: 600 })).rejects.toThrow(/only applies to effort ultra/);
    expect(client.agent.runs.create).not.toHaveBeenCalled();
  });

  it("stops ultra runs and cancels the rest", async () => {
    const client = fakeExaClient();
    const e = new ExaEngine(client, noSleep);
    await e.agentEnd("r1", "ultra");
    await e.agentEnd("r2", "high");
    expect(client.agent.runs.stop).toHaveBeenCalledWith("r1");
    expect(client.agent.runs.cancel).toHaveBeenCalledWith("r2");
  });

  it("reports worst-case cost per effort", () => {
    const e = new ExaEngine(fakeExaClient(), noSleep);
    expect(e.agentWorstCase({ query: "q", effort: "medium" })).toBe(0.1);
    expect(e.agentWorstCase({ query: "q", effort: "auto", budgetUsd: 2 })).toBe(2);
  });
});

describe("BraveEngine", () => {
  it("calls llm/context with the token header and maps grounding results", async () => {
    const { engine, fetchImpl } = fakeBrave(() => jsonResponse(BRAVE_PAYLOAD));
    const out = await engine.search({ text: "proxmox 9 release notes", numResults: 5, country: "de", lang: "DE", from: "2026-08-01" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe("https://api.search.brave.com/res/v1/llm/context");
    expect(u.searchParams.get("q")).toBe("proxmox 9 release notes");
    expect(u.searchParams.get("count")).toBe("5");
    expect(u.searchParams.get("maximum_number_of_urls")).toBe("5");
    expect(u.searchParams.get("country")).toBe("DE");
    expect(u.searchParams.get("search_lang")).toBe("de");
    expect(u.searchParams.get("freshness")).toBe("2026-08-01to2026-10-15");
    expect(init.headers).toMatchObject({ "X-Subscription-Token": "brave-key", Accept: "application/json" });

    expect(out.endpoint).toBe("llm/context");
    expect(out.costUsd).toBe(0.005);
    expect(out.results).toEqual([
      { url: "https://pve.proxmox.com/wiki/Roadmap", title: "Roadmap - Proxmox VE", snippets: ["Proxmox VE 9.0 is based on Debian 13", "ZFS 2.3"], engine: "brave", rank: 1 },
      { url: "https://forum.proxmox.com/threads/9-0.1", title: "Proxmox VE 9.0 released", snippets: ["Upgrade notes from 8 to 9"], engine: "brave", rank: 2 },
    ]);
  });

  it("clamps count to 50 and handles an empty response", async () => {
    const { engine, fetchImpl } = fakeBrave(() => jsonResponse({}));
    const out = await engine.search({ text: "q", numResults: 500 });
    expect(new URL(fetchImpl.mock.calls[0]![0]).searchParams.get("count")).toBe("50");
    expect(out.results).toEqual([]);
  });

  it("retries 429 using Retry-After and then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const engine = new BraveEngine("k", {
      fetchImpl: async () => (++n === 1 ? jsonResponse({}, { status: 429, headers: { "retry-after": "2" } }) : jsonResponse(BRAVE_PAYLOAD)),
      retry: { sleepFn: async (ms) => void waits.push(ms) },
    });
    const out = await engine.search({ text: "q", numResults: 2 });
    expect(out.results).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it("does not retry auth errors and surfaces the status", async () => {
    const { engine, fetchImpl } = fakeBrave(() => new Response("invalid subscription token", { status: 401 }));
    await expect(engine.search({ text: "q", numResults: 1 })).rejects.toThrow(/Brave API 401: invalid subscription token/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("builds freshness windows", () => {
    expect(braveFreshness()).toBeUndefined();
    expect(braveFreshness("2026-01-01", "2026-02-01")).toBe("2026-01-01to2026-02-01");
    expect(braveFreshness(undefined, "2026-02-01")).toBe("1970-01-01to2026-02-01");
  });
});
