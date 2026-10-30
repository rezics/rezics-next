import { ProblemError } from '../http/problem.ts';

/** Missing native evidence is retryable; it must never become a ready empty shelf. */
export class ShelfReadUnavailableError extends ProblemError {
  constructor(readonly binding: string) {
    super('dependency_unavailable', { detail: `Library shelf is preparing: ${binding}` });
    this.name = 'ShelfReadUnavailableError';
  }
}
