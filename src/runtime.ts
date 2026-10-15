import { Core } from "./core.js";
import type { Config, EngineId } from "./config.js";
import { Store } from "./db/store.js";
import { BraveEngine } from "./engines/brave.js";
import { ExaEngine, exaFromKey } from "./engines/exa.js";
import type { Engine } from "./engines/types.js";
import type { Logger } from "./log.js";
import { Limiter } from "./util.js";

export interface Runtime {
  config: Config;
  store: Store;
  engines: Partial<Record<EngineId, Engine>>;
  exa?: ExaEngine;
  log: Logger;
}

/** Concurrency per engine, matching the documented rate limits with headroom. */
const ENGINE_CONCURRENCY = 5;

/** Opens the database and builds the engines whose API keys are present. */
export function buildRuntime(config: Config, log: Logger, store: Store = Store.open(config.dbPath)): Runtime {
  const engines: Partial<Record<EngineId, Engine>> = {};
  let exa: ExaEngine | undefined;

  for (const id of config.engines) {
    if (id === "exa") {
      if (!config.exaApiKey) {
        log.warn("Exa is enabled but EXA_API_KEY is not set; Exa search, fetch and agent runs are unavailable.");
        continue;
      }
      exa = new ExaEngine(exaFromKey(config.exaApiKey), { limiter: new Limiter(ENGINE_CONCURRENCY) });
      engines.exa = exa;
    } else if (id === "brave") {
      if (!config.braveApiKey) {
        log.warn("Brave is enabled but BRAVE_API_KEY is not set; Brave is disabled.");
        continue;
      }
      engines.brave = new BraveEngine(config.braveApiKey, { limiter: new Limiter(ENGINE_CONCURRENCY) });
    }
  }
  return { config, store, engines, exa, log };
}

/** A Core for ad-hoc calls (no job, no spend cap). */
export function adhocCore(rt: Runtime): Core {
  return new Core({ config: rt.config, store: rt.store, engines: rt.engines, exa: rt.exa });
}
