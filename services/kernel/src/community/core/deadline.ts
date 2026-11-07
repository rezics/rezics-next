import type { CommunityDeadline } from '../contract/index.ts';

/** Wall-clock admission: a passed or non-finite deadline withholds work before storage. */
export function deadlineElapsed(now: number, deadline: CommunityDeadline): boolean {
  return !Number.isFinite(deadline) || !Number.isFinite(now) || now >= deadline;
}

export function remainingBudgetMs(now: number, deadline: CommunityDeadline): number {
  if (deadlineElapsed(now, deadline)) return 0;
  return deadline - now;
}

export function boundedDeadline(now: number, deadline: CommunityDeadline, budgetMs: number): CommunityDeadline {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError('Invalid deadline budget');
  return Math.min(deadline, now + budgetMs);
}
