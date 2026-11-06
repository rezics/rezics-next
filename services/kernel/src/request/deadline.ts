import { AsyncLocalStorage } from 'node:async_hooks';

type RequestDeadline = { deadline: number; ended: boolean };

const requestDeadlines = new AsyncLocalStorage<RequestDeadline>();

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) || typeof value === 'function') &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

/** Runs code with the request's shared deadline until its returned work settles. */
export function withRequestDeadline<T>(deadline: number, run: () => T): T {
  const requestDeadline: RequestDeadline = { deadline, ended: false };
  return requestDeadlines.run(requestDeadline, () => {
    try {
      const result = run();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).then(
          () => {
            requestDeadline.ended = true;
          },
          () => {
            requestDeadline.ended = true;
          },
        );
      } else {
        requestDeadline.ended = true;
      }
      return result;
    } catch (error) {
      requestDeadline.ended = true;
      throw error;
    }
  });
}

/** Returns the request deadline, or starts a fresh budget from `now` outside request work. */
export function deadlineFor(budgetMs: number, now: () => number = Date.now): number {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0)
    throw new TypeError('Deadline budget must be positive finite milliseconds');
  const requestDeadline = requestDeadlines.getStore();
  if (requestDeadline && !requestDeadline.ended) return requestDeadline.deadline;
  return now() + budgetMs;
}
