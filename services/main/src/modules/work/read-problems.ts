import { logWorkerFault } from '@rezics/observability/log';
import { problem } from 'elysia';
import { problemDefinition } from '../problem.ts';
import { MediaUnavailable } from '../media/store.ts';
import { ContextCommandUnavailable } from '../context/command.ts';
import { SearchSnapshotMoved } from './search-readiness.ts';
import { ReadingContinuityUnsupported } from '../reading-position/errors.ts';
import { WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from './read-session.ts';
import { FusekiReadBudgetExceeded, FusekiQueryResponseTooLarge, FusekiReadDeadlineExceeded } from '../../infrastructure/fuseki.ts';

export const invalidWorkRead = problemDefinition(400, 'invalid_work_read', 'Work read is invalid');
export const workReadMissing = problemDefinition(404, 'work_unavailable', 'Resource is unavailable');
export const readBasisChanged = problemDefinition(409, 'read_basis_changed', 'Restart the read from its first page');
export const workReadBudgetExceeded = problemDefinition(422, 'work_read_budget_exceeded', 'Work read exceeds its budget');
export const readingContinuityUnsupported = problemDefinition(503, 'reading_continuity_unsupported', 'Reading continuity is unsupported');
export const workReadUnavailable = problemDefinition(503, 'work_read_unavailable', 'Work read is unavailable');

export function workReadFailure(error: unknown) {
  if (error instanceof WorkReadInvalid) return problem({ ...invalidWorkRead.body, title: error.message });
  if (error instanceof WorkReadMissing) return problem(workReadMissing.body);
  if (error instanceof WorkReadMoved || error instanceof SearchSnapshotMoved) return problem(readBasisChanged.body);
  if (error instanceof WorkReadLimit || error instanceof FusekiReadBudgetExceeded
    || error instanceof FusekiQueryResponseTooLarge) return problem(workReadBudgetExceeded.body);
  if (error instanceof ReadingContinuityUnsupported) {
    return problem({ ...readingContinuityUnsupported.body, title: error.message });
  }
  if (error instanceof WorkReadUnavailable || error instanceof FusekiReadDeadlineExceeded
    || error instanceof MediaUnavailable || error instanceof ContextCommandUnavailable) {
    logWorkerFault('main.route.work_read_unavailable', error, { messages: false });
    return problem(workReadUnavailable.body);
  }
}
