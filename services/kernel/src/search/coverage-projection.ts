import type { BatchResult } from '../events/log.ts';
import { ProblemError } from '../http/problem.ts';
import type { IndexIncarnation, ProjectionOptions, SubjectProjectionCoordinator } from './coverage.ts';

/** Internal producer seam; no population, lifecycle, certificate or alternative event reader. */
export function createCoverageProjection(_options: ProjectionOptions): Pick<SubjectProjectionCoordinator, 'run'> {
  return {
    async run(_incarnation: IndexIncarnation, _partition: number): Promise<BatchResult> {
      // Requires durable admission and native observations around the indexer's actual apply.
      throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
    },
  };
}
