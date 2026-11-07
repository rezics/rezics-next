import { nativeSubjectReadingApplication } from './adapters/subject-reading.ts';
import type { SubjectCorrectionActionsInput } from './subject-reading-application.ts';

export {
  readSubjectPublicStates,
  subjectViewerActionResources,
  contextViewerActionResource,
} from './subject-reading-application.ts';
export type { SubjectCorrectionActions } from './subject-reading-application.ts';

/** Compatibility facade; the advice read itself belongs to the Subject reading application. */
export function readSubjectCorrectionActions(input: SubjectCorrectionActionsInput) {
  return nativeSubjectReadingApplication().readSubjectCorrectionActions(input);
}
