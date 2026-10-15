import { describe, expect, it } from "vitest";
import { PrivateUrlError, assertPublicUrl } from "../src/redact.js";
import { harness, LONG_TEXT } from "./helpers.js";

describe("assertPublicUrl", () => {
  it.each([
    "https://example.com/docs",
    "http://www.debian.org/security/",
    "https://203.0.113.7/page",
    "https://172.15.0.1/x", // just outside 172.16/12
    "https://172.32.0.1/x",
    "https://100.63.0.1/x", // just below CGNAT
    "https://pve.proxmox.com:8006/x",
    "https://[2001:db8::1]/x",
  ])("allows %s", (url) => {
    expect(() => assertPublicUrl(url)).not.toThrow();
  });

  it.each([
    ["http://localhost:8006/", /local or single-label host/],
    ["http://pve1/", /single-label/],
    ["https://pve1.corp.internal/api2/json", /private network name/],
    ["https://nas.local/share", /private network name/],
    ["https://router.lan/", /private network name/],
    ["https://printer.home.arpa/", /private network name/],
    ["http://192.168.1.10:8006/", /private IP/],
    ["http://10.0.0.5/", /private IP/],
    ["http://172.16.4.4/", /private IP/],
    ["http://172.31.255.255/", /private IP/],
    ["http://127.0.0.1:3000/", /private IP/],
    ["http://169.254.169.254/latest/meta-data/", /private IP/],
    ["http://100.100.1.1/", /private IP/], // Tailscale / CGNAT
    ["http://[::1]/", /private IPv6/],
    ["http://[fd12:3456::1]/", /private IPv6/],
    ["http://[fe80::1]/", /private IPv6/],
    ["https://user:pw@example.com/", /credentials/],
    ["not a url", /not a valid URL/],
    ["https://example.com/?token=ghp_" + "a".repeat(36), /secret/],
  ])("refuses %s", (url, why) => {
    expect(() => assertPublicUrl(url)).toThrow(PrivateUrlError);
    expect(() => assertPublicUrl(url)).toThrow(why);
  });

  it("refuses URLs containing a redacted term, case-insensitively", () => {
    expect(() => assertPublicUrl("https://paste.example.com/AcmeCorp-config", ["acmecorp"])).toThrow(/SPURHUND_REDACT/);
    expect(() => assertPublicUrl("https://paste.example.com/other", ["acmecorp"])).not.toThrow();
  });
});

describe("Core.fetch privacy", () => {
  it("never calls Exa for internal URLs, even when mixed with public ones", async () => {
    const h = harness({ exa: { getContents: (urls) => ({ results: urls.map((url) => ({ url, text: LONG_TEXT })) }) } });
    await expect(h.core.fetch({ urls: ["https://example.com/a", "http://192.168.1.10:8006/"] })).rejects.toThrow(/private IP/);
    expect(h.exaClient.getContents).not.toHaveBeenCalled();
  });

  it("applies the configured redact terms to URLs", async () => {
    const h = harness({ redact: ["acmecorp"] });
    await expect(h.core.fetch({ urls: ["https://pastebin.example/acmecorp-secrets"] })).rejects.toThrow(/SPURHUND_REDACT/);
    expect(h.exaClient.getContents).not.toHaveBeenCalled();
  });
});

describe("Core.agentStart privacy", () => {
  it("removes secrets and configured terms from the run's query and system prompt", async () => {
    const h = harness({ job: { cap: 5 }, redact: ["acmecorp"] });
    await h.core.agentStart("r1", {
      query: "Find AcmeCorp competitors; api key sk-ant-api03-ABCDEFGHIJKLMNOP must not leak",
      systemPrompt: "Ignore acmecorp internal pages",
      effort: "medium",
    });
    const sent = h.exaClient.agent.runs.create.mock.calls[0]![0] as { query: string; systemPrompt: string };
    expect(sent.query).toBe("Find competitors; api key must not leak");
    expect(sent.systemPrompt).toBe("Ignore internal pages");
  });

  it("refuses a run whose query is empty after redaction", async () => {
    const h = harness({ job: { cap: 5 }, redact: ["acmecorp"] });
    await expect(h.core.agentStart("r1", { query: "AcmeCorp", effort: "medium" })).rejects.toThrow(/empty after removing/);
    expect(h.exaClient.agent.runs.create).not.toHaveBeenCalled();
    expect(h.core.ledger!.remaining).toBe(5);
  });
});
