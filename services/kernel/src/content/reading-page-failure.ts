import { ProblemError } from '../http/problem-error.ts';
import { ReadingPageChangedError } from './contract/index.ts';

/** Map application failure at the retained reading transport boundary only. */
export async function readingPageBoundary<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ReadingPageChangedError)
      throw new ProblemError('dependency_unavailable', { detail: error.message });
    throw error;
  }
}
