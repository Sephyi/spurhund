/**
 * Price estimates in USD, used only when an API response carries no cost of its
 * own and to size worst-case reservations. Checked against Exa and Brave docs on
 * 2026-10-15; the live response (`costDollars`) always wins.
 */
export const PRICES = {
  exaSearch: 0.007,
  exaPage: 0.001,
  exaAgent: { medium: 0.1, high: 0.5, xhigh: 1.0 } as Record<string, number>,
  braveRequest: 0.005,
  /** Default caps Exa applies to metered efforts when no budget is passed. */
  exaAutoDefaultCap: 5,
  exaUltraDefaultCap: 20,
} as const;

export class BudgetExceededError extends Error {
  constructor(
    public readonly requested: number,
    public readonly remaining: number,
    public readonly cap: number,
  ) {
    super(
      `Exa budget for this job would be exceeded: requested $${requested.toFixed(3)}, remaining $${remaining.toFixed(3)} of $${cap.toFixed(2)}.`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface Reservation {
  /** Replaces the reserved amount with the actual cost. */
  settle(actual: number): void;
  /** Gives the reservation back without charging (call failed before spending). */
  release(): void;
}

/**
 * Hard spend cap for one job. Amounts are reserved before an engine call and
 * settled with the real cost afterwards, so parallel calls cannot overshoot.
 */
export class CostLedger {
  private settled: number;
  private reserved = 0;

  constructor(
    public readonly cap: number,
    initialSpent = 0,
  ) {
    this.settled = initialSpent;
  }

  get spent(): number {
    return this.settled;
  }

  get remaining(): number {
    return Math.max(0, this.cap - this.settled - this.reserved);
  }

  reserve(amount: number): Reservation {
    if (amount < 0) throw new RangeError("reservation must be >= 0");
    // Tolerate float noise at the boundary.
    if (this.settled + this.reserved + amount > this.cap + 1e-9) {
      throw new BudgetExceededError(amount, this.remaining, this.cap);
    }
    this.reserved += amount;
    let open = true;
    return {
      settle: (actual: number) => {
        if (!open) return;
        open = false;
        this.reserved -= amount;
        this.settled += actual;
      },
      release: () => {
        if (!open) return;
        open = false;
        this.reserved -= amount;
      },
    };
  }
}

export type AgentEffortName = "medium" | "high" | "xhigh" | "auto" | "ultra";

export const AGENT_EFFORTS: readonly AgentEffortName[] = ["medium", "high", "xhigh", "auto", "ultra"];

/** Worst-case cost of one Exa Agent run. Metered efforts cost up to their budget cap. */
export function agentWorstCase(effort: AgentEffortName, budgetUsd?: number): number {
  if (effort === "auto") return budgetUsd ?? PRICES.exaAutoDefaultCap;
  if (effort === "ultra") return budgetUsd ?? PRICES.exaUltraDefaultCap;
  return PRICES.exaAgent[effort]!;
}

/** Rough per-segment search effort by depth, used for the plan's cost estimate. */
export const DEPTH_ESTIMATES = {
  standard: { searches: 8, pages: 10 },
  deep: { searches: 15, pages: 25 },
  exhaustive: { searches: 25, pages: 40 },
} as const;

export function estimateSegmentExaSpend(depth: keyof typeof DEPTH_ESTIMATES): number {
  const e = DEPTH_ESTIMATES[depth];
  return e.searches * PRICES.exaSearch + e.pages * PRICES.exaPage;
}
