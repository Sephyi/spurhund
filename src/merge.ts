import { canonicalUrl } from "./canonical.js";

export interface EngineResult {
  url: string;
  title: string;
  publishedDate?: string;
  snippets: string[];
  engine: string;
  /** 1-based position within the engine's own result list. */
  rank: number;
}

export interface MergedResult {
  canonicalUrl: string;
  url: string;
  title: string;
  publishedDate?: string;
  snippets: string[];
  foundBy: { engine: string; rank: number }[];
  /** Reciprocal rank fusion score; higher is better. */
  score: number;
}

const RRF_K = 60;

function earliest(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return ta <= tb ? a : b;
}

/**
 * Groups results from several engines by canonical URL and orders them by
 * reciprocal rank fusion, so no engine's scoring scale dominates the others.
 */
export function mergeResults(lists: EngineResult[][]): MergedResult[] {
  const byKey = new Map<string, MergedResult>();
  for (const list of lists) {
    for (const r of list) {
      const key = canonicalUrl(r.url);
      let m = byKey.get(key);
      if (!m) {
        m = { canonicalUrl: key, url: r.url, title: r.title, publishedDate: r.publishedDate, snippets: [], foundBy: [], score: 0 };
        byKey.set(key, m);
      }
      if (!m.title && r.title) m.title = r.title;
      m.publishedDate = earliest(m.publishedDate, r.publishedDate);
      for (const s of r.snippets) {
        const t = s.trim();
        if (t && !m.snippets.includes(t)) m.snippets.push(t);
      }
      if (!m.foundBy.some((f) => f.engine === r.engine)) m.foundBy.push({ engine: r.engine, rank: r.rank });
      m.score += 1 / (RRF_K + r.rank);
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || a.canonicalUrl.localeCompare(b.canonicalUrl));
}
