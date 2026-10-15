const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "_hsenc",
  "_hsmi",
]);

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || TRACKING_PARAMS.has(n);
}

/**
 * Canonical form used as the dedupe key for sources:
 * scheme normalised to https, host lowercased without `www.`, default ports,
 * fragment and tracking parameters removed, remaining parameters sorted, trailing
 * slash removed. The path keeps its case. Non-http(s) input is returned trimmed.
 */
export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return trimmed;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const port = u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";

  const params = [...u.searchParams.entries()].filter(([k]) => !isTracking(k));
  params.sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";

  let pathname = u.pathname;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  if (pathname === "/") pathname = "";

  return `https://${host}${port}${pathname}${query}`;
}

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
