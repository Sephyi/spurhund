import { randomBytes } from "node:crypto";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Counting semaphore: at most `limit` tasks run at the same time. */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new RangeError("limit must be >= 1");
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

function statusOf(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { status?: unknown; statusCode?: unknown };
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

function retryAfterOf(err: unknown): number | undefined {
  return err instanceof EngineError ? err.retryAfterMs : undefined;
}

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${Math.round(ms / 1000)} s`);
    this.name = "TimeoutError";
  }
}

/** Rejects with TimeoutError when the promise has not settled in time. Retryable. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  const status = statusOf(err);
  if (status === undefined) {
    // Network-level failures from fetch surface as TypeError.
    return err instanceof TypeError;
  }
  return status === 429 || status >= 500;
}

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Retries 429, 5xx and network errors with exponential backoff, honouring Retry-After. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  const wait = opts.sleepFn ?? sleep;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryable(err)) throw err;
      const retryAfter = retryAfterOf(err);
      if (retryAfter !== undefined && retryAfter > 30_000) throw err;
      await wait(Math.min(retryAfter ?? baseMs * 2 ** i, 30_000));
    }
  }
  throw lastErr;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... truncated ${text.length - max} characters]`;
}
