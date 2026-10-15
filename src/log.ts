import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Logs to stderr (stdout belongs to the MCP stdio protocol) and, when a
 * directory is given, to `<dir>/<name>.log`. Never logs secrets: callers pass
 * messages, not config objects.
 */
export function createLogger(level: Config["logLevel"], opts: { dir?: string; name?: string; sink?: (line: string) => void } = {}): Logger {
  const min = LEVELS[level];
  let fd: number | undefined;
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line));

  const write = (lvl: Level, msg: string) => {
    if (LEVELS[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}\n`;
    sink(line);
    if (!opts.dir) return;
    try {
      if (fd === undefined) {
        fs.mkdirSync(opts.dir, { recursive: true });
        fd = fs.openSync(path.join(opts.dir, `${opts.name ?? "spurhund"}.log`), "a", 0o600);
      }
      fs.writeSync(fd, line);
    } catch {
      // A broken log file must never take the server down.
    }
  };

  return {
    debug: (m) => write("debug", m),
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}
