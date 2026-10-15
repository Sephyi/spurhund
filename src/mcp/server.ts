import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ENGINE_IDS } from "../config.js";
import type { Core } from "../core.js";
import { MAX_FETCH_URLS, DEFAULT_FETCH_CHARS } from "../core.js";
import { MAX_SEARCH_RESULTS } from "../engines/types.js";
import { errorMessage } from "../util.js";
import { fail, formatFetch, formatSearch, ok } from "./format.js";

export const SERVER_NAME = "spurhund";
export const SERVER_VERSION = "0.1.0";

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export const searchInput = z.object({
  query: z.string().min(1).max(2000).describe("Describe the page you want in a full phrase, not keywords."),
  objective: z
    .string()
    .max(4096)
    .optional()
    .describe("Goal of this search: which documents should rank first, which to exclude, what to pull from them. Used by Exa."),
  num_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(10).describe("About 5 for a named entity, 10 narrow, 15 broad; never above 25."),
  engines: z.array(z.enum(ENGINE_IDS)).optional().describe("Defaults to every configured engine; results are merged and deduplicated."),
  country: z.string().length(2).optional().describe("ISO country code that biases results, e.g. DE."),
  lang: z.string().min(2).max(5).optional().describe("Language hint for engines that support it (Brave). Exa follows the query's language."),
  from: isoDate.optional().describe("Only results published on or after this date. Drops undated pages; use only for a window that must hold."),
  to: isoDate.optional().describe("Only results published on or before this date."),
});

export const fetchInput = z.object({
  urls: z.array(z.string().url()).min(1).max(MAX_FETCH_URLS).describe("http(s) URLs; batch them."),
  max_characters: z
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(DEFAULT_FETCH_CHARS)
    .describe("Per page. Raise it for long documents; a page cut at the limit is flagged TRUNCATED."),
});

export interface McpContext {
  core: Core;
}

/** Registers the stateless search and fetch tools. */
export function registerSearchTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    "search",
    {
      title: "Search the web (Exa + Brave, merged)",
      description:
        "Searches every configured engine in parallel and returns one deduplicated list with the engine and rank that found each result. " +
        "Costs a few cents per call. Results are leads, not verified facts: read the best pages with `fetch` before relying on them.",
      inputSchema: searchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const out = await ctx.core.search({
          query: args.query,
          objective: args.objective,
          numResults: args.num_results,
          engines: args.engines,
          country: args.country,
          lang: args.lang,
          from: args.from,
          to: args.to,
        });
        return ok(formatSearch(out), {
          // Snippets are in the text; clients may pass both parts to the model, so do not repeat them.
          results: out.results.map(({ sourceId: _sourceId, snippets: _snippets, ...r }) => r),
          engines: out.engines,
          cost_usd: out.costUsd,
          redactions: out.redactions,
        });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Read web pages",
      description:
        "Fetches the text of up to 10 URLs (Exa contents, with a local cache). Each page is READ, TRUNCATED (cut at the limit) or NOT_READ " +
        "(empty, script shell, cookie/login wall, fetch error). Treat NOT_READ pages as unverified and never fill the gap from memory.",
      inputSchema: fetchInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const out = await ctx.core.fetch({ urls: args.urls, maxCharacters: args.max_characters });
        return ok(formatFetch(out), {
          // The text is in the readable part; repeating it here would double the payload.
          pages: out.pages.map(({ sourceId: _sourceId, text, ...p }) => ({ ...p, chars: text?.length ?? 0 })),
          cost_usd: out.costUsd,
        });
      } catch (err) {
        return fail(errorMessage(err));
      }
    },
  );
}

const BASE_INSTRUCTIONS =
  "spurhund: multi-engine web research. `search` and `fetch` are single calls. " +
  "Search results are leads; read pages before relying on claims, and say so when a page was NOT_READ.";

const JOB_INSTRUCTIONS =
  " For large questions use a research job: plan_research, show the user the plan and its worst-case cost, " +
  "start_research only after the user approves, then research_status and research_result. " +
  "Never add a language beyond English and German to a plan unless the user approved it.";

export function createMcpServer(
  ctx: McpContext,
  register: (server: McpServer) => void = () => {},
  opts: { withJobs?: boolean } = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: BASE_INSTRUCTIONS + (opts.withJobs ? JOB_INSTRUCTIONS : "") },
  );
  registerSearchTools(server, ctx);
  register(server);
  return server;
}
