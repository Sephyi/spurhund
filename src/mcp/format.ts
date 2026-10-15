import type { FetchOutput, SearchOutput } from "../core.js";
import { clip } from "../util.js";

const SNIPPET_CHARS = 500;
const SNIPPETS_PER_RESULT = 3;

const usd = (n: number) => `$${n.toFixed(4)}`;

export function formatSearch(out: SearchOutput, opts: { compact?: boolean } = {}): string {
  const engines = out.engines
    .map((e) => (e.ok ? `${e.engine} ok (${e.count})` : `${e.engine} FAILED (${e.error})`))
    .join(", ");
  const lines = [`${out.results.length} results. Engines: ${engines}. Cost ${usd(out.costUsd)}.`];
  if (out.redactions) lines.push(`Note: ${out.redactions} secret(s) or configured term(s) were removed from the query before sending.`);
  const results = opts.compact ? out.results.slice(0, 10) : out.results;
  results.forEach((r, i) => {
    const via = r.foundBy.map((f) => `${f.engine}#${f.rank}`).join(", ");
    const date = r.publishedDate ? ` (${r.publishedDate.slice(0, 10)})` : "";
    lines.push("", `${i + 1}. ${r.title || r.url}${date}`, `   ${r.url}  [${via}]`);
    for (const s of r.snippets.slice(0, opts.compact ? 1 : SNIPPETS_PER_RESULT)) {
      const text = s.replace(/\s+/g, " ");
      lines.push(`   - ${opts.compact ? text.slice(0, 300) : clip(text, SNIPPET_CHARS)}`);
    }
  });
  return lines.join("\n");
}

/** Upper bound on page text in one tool result; Claude Desktop cuts results at about 150,000 characters. */
export const MAX_RESULT_TEXT = 100_000;

/** Page text clipped so that all pages together stay under the budget. */
export function budgetPages<T extends { text: string | null; status: string }>(pages: T[], budget = MAX_RESULT_TEXT): (Omit<T, 'status'> & { status: T['status'] | 'truncated'; clipped: boolean })[] {
  const total = pages.reduce((n, p) => n + (p.text?.length ?? 0), 0);
  if (total <= budget) return pages.map((p) => ({ ...p, clipped: false }));
  const each = Math.floor(budget / Math.max(1, pages.filter((p) => p.text).length));
  return pages.map((p) =>
    p.text && p.text.length > each ? { ...p, text: p.text.slice(0, each), status: "truncated" as const, clipped: true } : { ...p, clipped: false },
  );
}

export function formatFetch(out: FetchOutput, budget = MAX_RESULT_TEXT): string {
  const pages = budgetPages(out.pages, budget);
  const parts = [`${pages.length} page(s). Cost ${usd(out.costUsd)}.`];
  if (pages.some((p) => p.clipped)) parts.push(`Note: the combined text was shortened to fit one result; fetch fewer pages at a time to read more of each.`);
  for (const p of pages) {
    const flags = [p.status.toUpperCase(), p.cached ? "cached" : undefined, p.reason].filter(Boolean).join(", ");
    parts.push("", `=== ${p.url} [${flags}]${p.title ? `\n${p.title}` : ""}`);
    if (p.status === "not_read") parts.push("(not read: do not rely on this page)");
    else {
      parts.push(p.text ?? "");
      if (p.status === "truncated") parts.push("[text was cut at the character limit; fetch again with a higher max_characters if the part you need is missing]");
    }
  }
  return parts.join("\n");
}

/** Wraps a payload as an MCP tool result with both readable text and structured data. */
export function ok(text: string, structured: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

export function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}
