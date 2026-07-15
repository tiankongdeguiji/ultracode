/**
 * Token budget accounting. Enforcement is a dispatch gate (checked before
 * each agent() spawn), not a mid-flight kill: in-flight agents finish, the
 * next dispatch throws — matching the no-silent-caps doctrine.
 */

export interface BudgetLike {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

export class BudgetAccount implements BudgetLike {
  private spentTokens = 0;
  private estimatedTokens = 0;

  constructor(readonly total: number | null) {}

  spent(): number {
    return this.spentTokens;
  }

  remaining(): number {
    if (this.total === null) return Infinity;
    return Math.max(0, this.total - this.spentTokens);
  }

  /** True when any accounted usage was a chars/4 estimate. */
  hasEstimates(): boolean {
    return this.estimatedTokens > 0;
  }

  add(tokens: number, estimated = false): void {
    this.spentTokens += tokens;
    if (estimated) this.estimatedTokens += tokens;
  }

  /** Read-only view exposed to workflow scripts as the `budget` global. */
  scriptView(): { total: number | null; spent: () => number; remaining: () => number } {
    return {
      total: this.total,
      spent: () => this.spent(),
      remaining: () => this.remaining(),
    };
  }
}
