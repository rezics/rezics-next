import type { ContentDeadline } from '../contract/index.ts';
/** Wall-clock admission: a passed or non-finite deadline withholds work before storage. */
export declare function deadlineElapsed(now: number, deadline: ContentDeadline): boolean;
export declare function remainingBudgetMs(now: number, deadline: ContentDeadline): number;
export declare function boundedDeadline(now: number, deadline: ContentDeadline, budgetMs: number): ContentDeadline;
