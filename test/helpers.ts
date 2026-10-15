import { vi } from "vitest";
import { Core, type CoreDeps } from "../src/core.js";
import { CostLedger } from "../src/costs.js";
import { Store } from "../src/db/store.js";
import { BraveEngine, type FetchLike } from "../src/engines/brave.js";
import { ExaEngine, type AgentRunLike, type ExaClientLike, type ExaResponseLike } from "../src/engines/exa.js";

export const LONG_TEXT = "Proxmox VE 9.0 release notes. ".repeat(40); // ~1200 chars

export interface FakeExaOptions {
  search?: (query: string, options: Record<string, unknown>) => ExaResponseLike | Promise<ExaResponseLike>;
  getContents?: (urls: string[], options: Record<string, unknown>) => ExaResponseLike | Promise<ExaResponseLike>;
  create?: (params: Record<string, unknown>) => AgentRunLike | Promise<AgentRunLike>;
  get?: (id: string) => AgentRunLike | Promise<AgentRunLike>;
  list?: () => AgentRunLike[] | Promise<AgentRunLike[]>;
}

export function fakeExaClient(o: FakeExaOptions = {}) {
  const client = {
    search: vi.fn(async (q: string, opts: Record<string, unknown>) => (o.search ? o.search(q, opts) : { results: [] })),
    getContents: vi.fn(async (urls: string[], opts: Record<string, unknown>) =>
      o.getContents ? o.getContents(urls, opts) : { results: [] },
    ),
    agent: {
      runs: {
        create: vi.fn(async (p: Record<string, unknown>) => (o.create ? o.create(p) : { id: "run_1", status: "running" as const })),
        get: vi.fn(async (id: string) => (o.get ? o.get(id) : { id, status: "completed" as const })),
        stop: vi.fn(async (id: string) => ({ id, status: "completed" as const, stopReason: "stopped" })),
        cancel: vi.fn(async (id: string) => ({ id, status: "cancelled" as const })),
        list: vi.fn(async (_p?: { limit?: number }) => ({ data: (o.list ? await o.list() : []) as AgentRunLike[] })),
      },
    },
  };
  return client satisfies ExaClientLike;
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export const BRAVE_PAYLOAD = {
  grounding: {
    generic: [
      { url: "https://pve.proxmox.com/wiki/Roadmap", title: "Roadmap - Proxmox VE", snippets: ["Proxmox VE 9.0 is based on Debian 13", "ZFS 2.3"] },
      { url: "https://forum.proxmox.com/threads/9-0.1", snippets: ["Upgrade notes from 8 to 9"] },
    ],
  },
  sources: {
    "https://forum.proxmox.com/threads/9-0.1": { title: "Proxmox VE 9.0 released", hostname: "forum.proxmox.com" },
  },
};

export function fakeBrave(handler: (url: string, init: { headers: Record<string, string> }) => Response | Promise<Response>) {
  const fetchImpl = vi.fn<FetchLike>(async (url, init) => handler(url, init));
  const engine = new BraveEngine("brave-key", { fetchImpl, retry: { sleepFn: async () => {} }, today: () => new Date("2026-10-15T00:00:00Z") });
  return { engine, fetchImpl };
}

export interface Harness {
  core: Core;
  store: Store;
  exaClient: ReturnType<typeof fakeExaClient>;
  exa: ExaEngine;
  brave: ReturnType<typeof fakeBrave>;
}

/** A Core wired to fakes. Pass `job` to attribute calls to a job with a spend cap. */
export function harness(opts: { exa?: FakeExaOptions; brave?: Parameters<typeof fakeBrave>[0]; job?: { cap: number }; redact?: string[]; engines?: ("exa" | "brave")[]; cacheDays?: number } = {}): Harness {
  const store = Store.memory();
  const exaClient = fakeExaClient(opts.exa);
  const exa = new ExaEngine(exaClient, { retry: { sleepFn: async () => {} } });
  const brave = fakeBrave(opts.brave ?? (() => jsonResponse(BRAVE_PAYLOAD)));
  const enabled = opts.engines ?? ["exa", "brave"];
  const deps: CoreDeps = {
    config: { redact: opts.redact ?? [], fetchCacheDays: opts.cacheDays ?? 7, engines: enabled },
    store,
    // Like the real wiring, only configured engines are present.
    engines: { ...(enabled.includes("exa") ? { exa } : {}), ...(enabled.includes("brave") ? { brave: brave.engine } : {}) },
    exa,
  };
  if (opts.job) {
    const plan = store.createPlan({ question: "q", depth: "standard", plan: {}, worstCaseUsd: 0, maxExaUsd: opts.job.cap });
    const jobId = store.createJob({ planId: plan, authMode: "oauth", models: {}, maxExaUsd: opts.job.cap });
    deps.jobId = jobId;
    deps.ledger = new CostLedger(opts.job.cap);
  }
  return { core: new Core(deps), store, exaClient, exa, brave };
}
