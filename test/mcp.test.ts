import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/mcp/server.js";
import { LONG_TEXT, harness, type Harness } from "./helpers.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function connect(h: Harness) {
  const server = createMcpServer({ core: h.core });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const text = (r: { content?: unknown }) => ((r.content as { type: string; text: string }[])[0]!).text;

describe("MCP search and fetch tools", () => {
  it("lists the tools with annotations Claude clients require", async () => {
    const client = await connect(harness());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["fetch", "search"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
      expect(t.description!.length).toBeGreaterThan(40);
    }
    const search = tools.find((t) => t.name === "search")!;
    expect(search.inputSchema.required).toEqual(["query"]);
    expect(Object.keys(search.inputSchema.properties as object)).toEqual(
      expect.arrayContaining(["query", "objective", "num_results", "engines", "country", "lang", "from", "to"]),
    );
  });

  it("search returns readable text and structured results with provenance", async () => {
    const h = harness({ exa: { search: () => ({ results: [{ url: "https://pve.proxmox.com/wiki/Roadmap", title: "Roadmap", highlights: ["exa hl"] }], costDollars: { total: 0.01 } }) } });
    const client = await connect(h);
    const res = await client.callTool({ name: "search", arguments: { query: "proxmox roadmap", objective: "official roadmap", num_results: 5 } });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/2 results\. Engines: exa ok \(1\), brave ok \(2\)/);
    expect(text(res)).toContain("https://pve.proxmox.com/wiki/Roadmap  [exa#1, brave#1]");
    const sc = res.structuredContent as { results: { canonicalUrl: string; foundBy: unknown[]; sourceId?: number }[]; cost_usd: number };
    expect(sc.results[0]!.foundBy).toHaveLength(2);
    expect(sc.results[0]).not.toHaveProperty("sourceId");
    expect(sc.cost_usd).toBeCloseTo(0.015);
    expect(h.exaClient.search.mock.calls[0]![1]).toMatchObject({ numResults: 5, objective: "official roadmap" });
  });

  it("validates arguments before running anything", async () => {
    const h = harness();
    const client = await connect(h);
    for (const args of [{}, { query: "" }, { query: "q", num_results: 26 }, { query: "q", from: "yesterday" }, { query: "q", engines: ["bing"] }, { query: "q", country: "DEU" }]) {
      const res = await client.callTool({ name: "search", arguments: args }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
      expect(res.isError, JSON.stringify(args)).toBe(true);
    }
    expect(h.exaClient.search).not.toHaveBeenCalled();
  });

  it("reports engine failures as a tool error, not a protocol error", async () => {
    const h = harness({ engines: ["exa"], exa: { search: () => { throw new Error("exa is down"); } } });
    const client = await connect(h);
    const res = await client.callTool({ name: "search", arguments: { query: "q" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/All engines failed.*exa is down/s);
  });

  it("tells the model about removed secrets", async () => {
    const h = harness({ redact: ["corp.internal"] });
    const client = await connect(h);
    const res = await client.callTool({ name: "search", arguments: { query: "pve1.corp.internal dns" } });
    expect(text(res)).toMatch(/1 secret\(s\) or configured term\(s\) were removed/);
  });

  it("fetch returns page text with status flags and caches the repeat", async () => {
    const h = harness({
      exa: {
        getContents: (urls) => ({
          results: [{ url: urls[0]!, title: "Doc", text: LONG_TEXT }],
          statuses: [{ id: "https://gone.example/x", status: "error", error: { tag: "CRAWL_NOT_FOUND" } }],
          costDollars: { total: 0.002 },
        }),
      },
    });
    const client = await connect(h);
    const res = await client.callTool({ name: "fetch", arguments: { urls: ["https://e.com/doc", "https://gone.example/x"], max_characters: 12_000 } });
    expect(res.isError).toBeFalsy();
    const t = text(res);
    expect(t).toContain("=== https://e.com/doc [READ]");
    expect(t).toContain("=== https://gone.example/x [NOT_READ, fetch failed: CRAWL_NOT_FOUND]");
    expect(t).toContain("(not read: do not rely on this page)");
    const sc = res.structuredContent as { pages: { url: string; status: string }[] };
    expect(sc.pages.map((p) => p.status)).toEqual(["read", "not_read"]);

    const again = await client.callTool({ name: "fetch", arguments: { urls: ["https://e.com/doc"] } });
    expect(text(again)).toContain("[READ, cached]");
  });

  it("fetch flags truncated pages and explains the fix", async () => {
    const h = harness({ exa: { getContents: (urls, o) => ({ results: [{ url: urls[0]!, text: "x".repeat((o.text as { maxCharacters: number }).maxCharacters) }] }) } });
    const client = await connect(h);
    const res = await client.callTool({ name: "fetch", arguments: { urls: ["https://e.com/long"], max_characters: 1000 } });
    expect(text(res)).toMatch(/\[TRUNCATED\]/);
    expect(text(res)).toMatch(/fetch again with a higher max_characters/);
  });

  it("fetch rejects bad URLs and oversized batches", async () => {
    const client = await connect(harness());
    const bad = await client.callTool({ name: "fetch", arguments: { urls: ["not a url"] } }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
    expect(bad.isError).toBe(true);
    const many = await client.callTool({ name: "fetch", arguments: { urls: Array.from({ length: 11 }, (_, i) => `https://e.com/${i}`) } }).catch((e: Error) => ({ isError: true, content: [{ type: "text", text: e.message }] }));
    expect(many.isError).toBe(true);
  });

  it("advertises server instructions", async () => {
    const client = await connect(harness());
    expect(client.getServerVersion()).toMatchObject({ name: "spurhund" });
    expect(client.getInstructions()).toMatch(/leads/);
  });
});
