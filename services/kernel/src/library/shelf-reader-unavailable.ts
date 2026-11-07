import { memoizedValue } from '../memoized.ts';
import { ProblemError } from '../http/problem-error.ts';

/** Missing native evidence is retryable; it must never become a ready empty shelf. */
export function ShelfReadUnavailableError() {
  return memoizedValue(
    ShelfReadUnavailableError,
    () =>
      class ShelfReadUnavailableError extends ProblemError {
        constructor(readonly binding: string) {
          super('dependency_unavailable', { detail: `Library shelf is preparing: ${binding}` });
          this.name = 'ShelfReadUnavailableError';
        }
      },
  );
}
export type ShelfReadUnavailableError = InstanceType<ReturnType<typeof ShelfReadUnavailableError>>;
