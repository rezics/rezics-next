import { ProblemError } from '../../../src/http/problem.ts';
import {
  activateSubjectIncarnation,
  createSubjectProjectionCoordinator,
  initializeSubjectIncarnation,
  type IndexIncarnation,
  type ProjectionOptions,
  type SubjectProjectionCoordinator,
} from '../../../src/search/coverage.ts';
import { installTemplates } from '../../../src/search/query.ts';

function requireTime(deadline: number): void {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw new ProblemError('deadline_exceeded');
}

/** Run the real bounded population sequence against the caller's existing Search runtime. */
export async function populateControlledSubjects(
  options: ProjectionOptions,
  request: { generation?: number; deadline: number },
): Promise<{ incarnation: IndexIncarnation; coordinator: SubjectProjectionCoordinator }> {
  requireTime(request.deadline);
  const incarnation = await initializeSubjectIncarnation(options, request.generation ?? 1);
  requireTime(request.deadline);
  const coordinator = createSubjectProjectionCoordinator(options);

  let population: { state: 'more' | 'complete' };
  do {
    requireTime(request.deadline);
    population = await coordinator.populate(incarnation);
  } while (population.state === 'more');

  requireTime(request.deadline);
  const certified = await coordinator.certify(incarnation, { deadline: request.deadline });
  if (certified.state !== 'ready') throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });

  requireTime(request.deadline);
  await activateSubjectIncarnation(options, incarnation);
  requireTime(request.deadline);
  await installTemplates(options.search, options.prefix);
  requireTime(request.deadline);

  return { incarnation, coordinator };
}
