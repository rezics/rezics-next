/** Runs code with the request's shared deadline until its returned work settles. */
export declare function withRequestDeadline<T>(deadline: number, run: () => T): T;
/** Returns the request deadline, or starts a fresh budget outside request work. */
export declare function deadlineFor(budgetMs: number): number;
