import { ProblemError } from '../../http/problem-error.ts';
import { SearchOperationError } from '../operation-outcomes.ts';
import { OwnerCurrentRestartRequired } from '../discovery-errors.ts';

/** The route is the sole constructor of HTTP problems for native disclosure failures. */
export function searchOperationProblem(error: unknown): unknown {
  if (error instanceof OwnerCurrentRestartRequired) return new ProblemError('search_restart_required');
  if (!(error instanceof SearchOperationError)) return error;
  return new ProblemError(error.code, {
    ...(error.errors === undefined ? {} : { errors: error.errors }),
    ...(error.extensions === undefined ? {} : { extensions: error.extensions }),
    ...(error.code === 'index_not_ready' || error.code === 'semantic_not_ready'
      ? { headers: { 'retry-after': '1' } }
      : {}),
  });
}
