import type { CandidateWork } from '../../subject/candidate-lifetime';

/** A retired closure refuses before calling a server function or reading current browser CSRF. */
export function editorRequest<Input extends object>(
  input: Input,
  work: CandidateWork,
): Input & { expectedReader: string } {
  if (!work.live()) throw new Error('Retired catalogue editor');
  return { ...input, expectedReader: work.reader };
}
