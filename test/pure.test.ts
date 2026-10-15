import { describe, expect, it } from "vitest";
import { canonicalUrl, hostnameOf } from "../src/canonical.js";
import { BudgetExceededError, CostLedger, agentWorstCase, estimateSegmentExaSpend } from "../src/costs.js";
import { mergeResults, type EngineResult } from "../src/merge.js";
import { EmptyAfterRedactionError, redact, redactQuery } from "../src/redact.js";
import { EngineError, Limiter, isRetryable, withRetry } from "../src/util.js";

describe("canonicalUrl", () => {
  it("normalises scheme, www, fragment, trailing slash and port", () => {
    expect(canonicalUrl("http://WWW.Example.com:80/Path/#frag")).toBe("https://example.com/Path");
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com");
    expect(canonicalUrl("https://example.com:8443/a/")).toBe("https://example.com:8443/a");
  });

  it("drops tracking parameters and sorts the rest", () => {
    expect(canonicalUrl("https://e.com/p?b=2&utm_source=x&a=1&gclid=zz&ref=tw&fbclid=1")).toBe("https://e.com/p?a=1&b=2");
    expect(canonicalUrl("https://e.com/p?utm_medium=m")).toBe("https://e.com/p");
  });

  it("keeps path case and is idempotent", () => {
    const once = canonicalUrl("https://GitHub.com/User/Repo/?tab=readme#top");
    expect(once).toBe("https://github.com/User/Repo?tab=readme");
    expect(canonicalUrl(once)).toBe(once);
  });

  it("returns non-http input trimmed", () => {
    expect(canonicalUrl("  mailto:a@b.c ")).toBe("mailto:a@b.c");
    expect(canonicalUrl("not a url")).toBe("not a url");
  });

  it("extracts hostnames", () => {
    expect(hostnameOf("https://www.Sub.Example.com/x")).toBe("sub.example.com");
    expect(hostnameOf("garbage")).toBeNull();
  });
});

describe("redact", () => {
  it("removes configured terms case-insensitively", () => {
    const r = redact("why does Corp.Internal fail dns for pve1.corp.internal", ["corp.internal"]);
    // Whole internal host names go, not just the configured fragment.
    expect(r.text).toBe("why does fail dns for");
    expect(r.redactions).toBe(2);
  });

  it("treats terms literally, not as regex", () => {
    expect(redact("a+b and a.b", ["a+b"]).text).toBe("and a.b");
  });

  it("removes common secret formats", () => {
    const q = [
      "key sk-ant-api03-ABCDEFGHIJKLMNOP",
      "aws " + "AKIA" + "ABCDEFGHIJKLMNOP",
      "gh ghp_" + "a".repeat(36),
      "brave BSA" + "b".repeat(24),
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----",
    ].join(" ; ");
    const r = redact(q);
    expect(r.redactions).toBeGreaterThanOrEqual(7);
    for (const leaked of ["sk-ant", "AKIA", "ghp_", "BSAb", "eyJhbGci", "abcdefghijklmnopqrstuvwxyz0123", "PRIVATE KEY"]) {
      expect(r.text).not.toContain(leaked);
    }
  });

  it("leaves ordinary text alone", () => {
    const r = redact("official Proxmox VE 9.0 release notes");
    expect(r).toEqual({ text: "official Proxmox VE 9.0 release notes", redactions: 0 });
  });

  it("redactQuery throws when nothing is left", () => {
    expect(() => redactQuery("corp.internal", ["corp.internal"])).toThrow(EmptyAfterRedactionError);
  });
});

describe("mergeResults", () => {
  const r = (engine: string, url: string, rank: number, extra: Partial<EngineResult> = {}): EngineResult => ({
    engine,
    url,
    rank,
    title: extra.title ?? url,
    snippets: extra.snippets ?? [],
    publishedDate: extra.publishedDate,
  });

  it("groups by canonical URL and records which engines found it", () => {
    const m = mergeResults([
      [r("exa", "https://www.a.com/x?utm_source=t", 1, { snippets: ["s1"] }), r("exa", "https://b.com/y", 2)],
      [r("brave", "http://a.com/x#frag", 3, { snippets: ["s1", "s2"], publishedDate: "2026-01-02" })],
    ]);
    expect(m).toHaveLength(2);
    const a = m.find((x) => x.canonicalUrl === "https://a.com/x")!;
    expect(a.foundBy).toEqual([
      { engine: "exa", rank: 1 },
      { engine: "brave", rank: 3 },
    ]);
    expect(a.snippets).toEqual(["s1", "s2"]);
    expect(a.publishedDate).toBe("2026-01-02");
  });

  it("ranks sources found by several engines first (RRF)", () => {
    const m = mergeResults([
      [r("exa", "https://top-exa.com", 1), r("exa", "https://both.com", 2)],
      [r("brave", "https://both.com", 2), r("brave", "https://only-brave.com", 1)],
    ]);
    expect(m[0]!.canonicalUrl).toBe("https://both.com");
  });

  it("keeps the earliest publication date", () => {
    const m = mergeResults([
      [r("exa", "https://a.com", 1, { publishedDate: "2026-05-01" })],
      [r("brave", "https://a.com", 1, { publishedDate: "2026-02-01" })],
    ]);
    expect(m[0]!.publishedDate).toBe("2026-02-01");
  });

  it("is deterministic for equal scores", () => {
    const m = mergeResults([[r("exa", "https://b.com", 1)], [r("brave", "https://a.com", 1)]]);
    expect(m.map((x) => x.canonicalUrl)).toEqual(["https://a.com", "https://b.com"]);
  });
});

describe("CostLedger", () => {
  it("reserves, settles with the actual cost and frees the difference", () => {
    const l = new CostLedger(1);
    const r = l.reserve(0.4);
    expect(l.remaining).toBeCloseTo(0.6);
    r.settle(0.1);
    expect(l.spent).toBeCloseTo(0.1);
    expect(l.remaining).toBeCloseTo(0.9);
  });

  it("refuses reservations beyond the cap, counting outstanding reservations", () => {
    const l = new CostLedger(1);
    l.reserve(0.7);
    expect(() => l.reserve(0.4)).toThrow(BudgetExceededError);
    expect(() => l.reserve(0.3)).not.toThrow();
  });

  it("release gives the amount back and double-settle is ignored", () => {
    const l = new CostLedger(1);
    const r = l.reserve(0.5);
    r.release();
    r.settle(0.5);
    expect(l.spent).toBe(0);
    expect(l.remaining).toBe(1);
  });

  it("starts from previously spent money", () => {
    const l = new CostLedger(5, 4.5);
    expect(() => l.reserve(1)).toThrow(BudgetExceededError);
    expect(l.remaining).toBeCloseTo(0.5);
  });

  it("allows the exact remaining amount despite float noise", () => {
    const l = new CostLedger(0.3);
    l.reserve(0.1).settle(0.1);
    l.reserve(0.1).settle(0.1);
    expect(() => l.reserve(0.1)).not.toThrow();
  });
});

describe("agent cost helpers", () => {
  it("prices fixed efforts and uses the budget for metered ones", () => {
    expect(agentWorstCase("medium")).toBe(0.1);
    expect(agentWorstCase("high")).toBe(0.5);
    expect(agentWorstCase("xhigh")).toBe(1);
    expect(agentWorstCase("auto", 3)).toBe(3);
    expect(agentWorstCase("auto")).toBe(5);
    expect(agentWorstCase("ultra")).toBe(20);
    expect(agentWorstCase("ultra", 12)).toBe(12);
  });

  it("scales the per-segment estimate with depth", () => {
    expect(estimateSegmentExaSpend("standard")).toBeLessThan(estimateSegmentExaSpend("deep"));
    expect(estimateSegmentExaSpend("deep")).toBeLessThan(estimateSegmentExaSpend("exhaustive"));
  });
});

describe("withRetry", () => {
  const noSleep = async () => {};

  it("retries 429 and 5xx, then succeeds", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 3) throw new EngineError("busy", n === 1 ? 429 : 503);
        return "ok";
      },
      { sleepFn: noSleep },
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("does not retry client errors", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new EngineError("bad", 400);
        },
        { sleepFn: noSleep },
      ),
    ).rejects.toThrow("bad");
    expect(n).toBe(1);
  });

  it("gives up after the attempt limit and honours Retry-After", async () => {
    const waits: number[] = [];
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new EngineError("slow down", 429, 1234);
        },
        { attempts: 3, sleepFn: async (ms) => void waits.push(ms) },
      ),
    ).rejects.toThrow("slow down");
    expect(n).toBe(3);
    expect(waits).toEqual([1234, 1234]);
  });

  it("recognises status and statusCode on foreign errors", () => {
    expect(isRetryable({ statusCode: 502 })).toBe(true);
    expect(isRetryable({ status: 401 })).toBe(false);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryable(new Error("other"))).toBe(false);
  });
});

describe("Limiter", () => {
  it("never runs more than the limit at once", async () => {
    const l = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        l.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("releases the slot when a task throws", async () => {
    const l = new Limiter(1);
    await expect(l.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(l.run(async () => "fine")).resolves.toBe("fine");
  });
});
