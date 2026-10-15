import { domainToUnicode } from "node:url";

/** Patterns for credentials that must never leave the machine in a search query. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g, // Anthropic (sk-ant-), OpenAI (sk-proj-, sk-svcacct-) and similar
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\bBSA[A-Za-z0-9_-]{20,}/g, // Brave
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|token|secret|password|passwd)=[^\s&"']{8,}/gi, // key=value in URLs and configs
];

/** Name suffixes that only exist on private networks (RFC 6761/6762, common internal TLDs). */
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".localdomain", ".home.arpa"];

export interface Redacted {
  text: string;
  /** Number of removed spans (secrets, private hosts and addresses, configured terms). */
  redactions: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class EmptyAfterRedactionError extends Error {
  constructor() {
    super("The query is empty after removing secrets and redacted terms; rephrase it without them.");
    this.name = "EmptyAfterRedactionError";
  }
}

export class PrivateUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Not sent to a third-party service: ${url} ${reason}.`);
    this.name = "PrivateUrlError";
  }
}

// ------------------------------------------------------------- addresses

function isPrivateIPv4Parts(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  return isPrivateIPv4Parts(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Expands an IPv6 literal (as normalised by WHATWG URL) into its eight 16-bit groups. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":").map((g) => Number.parseInt(g, 16)) : []);
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const groups = halves.length === 2 ? [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail] : head;
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateIPv6(host: string): boolean {
  const g = ipv6Groups(host);
  if (!g) return false;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(7) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  const embedded = () => isPrivateIPv4Parts(g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8);
  if (zeroUpTo(5) && g[5] === 0xffff) return embedded(); // IPv4-mapped ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(); // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  const first = g[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (first & 0xff00) === 0xff00 // multicast
  );
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Why a URL must not be handed to a third party, or null when it may. */
export function privateUrlReason(raw: string, terms: readonly string[] = []): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "is not a valid URL";
  }
  if (u.username || u.password) return "contains credentials";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || (!host.includes(".") && !host.includes(":"))) return "points at a local or single-label host";
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return "points at a private network name";
  if (isPrivateIPv4(host)) return "is a private IP address";
  if (isPrivateIPv6(host)) return "is a private IPv6 address";

  // Terms are matched against every spelling a reader of the URL would see:
  // raw, percent-decoded and the Unicode form of a punycode host.
  const haystack = [raw, safeDecode(raw), u.href, safeDecode(u.href), domainToUnicode(host)].join(" ").toLowerCase();
  for (const t of terms) {
    const term = t.trim().toLowerCase();
    if (term && haystack.includes(term)) return "contains a term from SPURHUND_REDACT";
  }
  if (SECRET_PATTERNS.some((re) => new RegExp(re.source, re.flags).test(raw) || new RegExp(re.source, re.flags).test(safeDecode(raw)))) {
    return "contains what looks like a secret";
  }
  return null;
}

/**
 * Pages are fetched by Exa's servers, so a URL is a message to a third party.
 * Refuses private and internal targets and URLs containing a redacted term or a secret.
 */
export function assertPublicUrl(raw: string, terms: readonly string[] = []): void {
  const reason = privateUrlReason(raw, terms);
  if (reason) throw new PrivateUrlError(raw, reason);
}

// ----------------------------------------------------------- redaction

const URL_TOKEN = /\bhttps?:\/\/[^\s"'<>()]+/gi;
const IPV4_TOKEN = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d{1,5})?\b/g;
const PRIVATE_HOST_TOKEN = new RegExp(
  `\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?:${[...PRIVATE_SUFFIXES].sort((a, b) => b.length - a.length).map((s) => escapeRegExp(s)).join("|")})\\b(?::\\d{1,5})?`,
  "gi",
);

/**
 * Removes what must not reach a search engine: secrets, URLs that point at
 * private targets, private IPv4 addresses and internal host names, and the
 * configured terms (internal names, the API keys themselves).
 */
export function redact(text: string, terms: readonly string[] = []): Redacted {
  let out = text;
  let redactions = 0;
  const strip = (re: RegExp, keep?: (match: string, group: string | undefined) => boolean) => {
    out = out.replace(re, (match: string, group?: string) => {
      if (keep?.(match, typeof group === "string" ? group : undefined)) return match;
      redactions++;
      return " ";
    });
  };

  for (const re of SECRET_PATTERNS) strip(new RegExp(re.source, re.flags));
  strip(new RegExp(URL_TOKEN.source, URL_TOKEN.flags), (url) => privateUrlReason(url.replace(/[.,;:!?]+$/, ""), terms) === null);
  strip(new RegExp(IPV4_TOKEN.source, IPV4_TOKEN.flags), (_m, ip) => !ip || !isPrivateIPv4(ip));
  strip(new RegExp(PRIVATE_HOST_TOKEN.source, PRIVATE_HOST_TOKEN.flags));
  for (const term of terms) {
    const t = term.trim();
    if (t) strip(new RegExp(escapeRegExp(t), "gi"));
  }
  out = out.replace(/\s+/g, " ").trim();
  return { text: out, redactions };
}

/** Like {@link redact} but throws when nothing searchable is left. */
export function redactQuery(text: string, terms: readonly string[] = []): Redacted {
  const r = redact(text, terms);
  if (!r.text) throw new EmptyAfterRedactionError();
  return r;
}
