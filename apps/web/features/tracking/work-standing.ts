import type { WorkMark } from './media-api.ts';

type StandingAnswer = { ok: true; data: WorkMark }
  | { ok: false; failure: string; status?: number; problem?: unknown };

/** Progress on parts makes the whole-Work control absent; every other failure stays recoverable. */
export function workStandingRead(answer: StandingAnswer):
  { status: 'ready'; mark: WorkMark } | { status: 'absent' } | { status: 'failed'; answer: StandingAnswer } {
  if (answer.ok) return { status: 'ready', mark: answer.data };
  const code = answer.problem && typeof answer.problem === 'object' && 'code' in answer.problem
    ? answer.problem.code : undefined;
  if (['sign-in', 'missing', 'closed', 'has-parts'].includes(answer.failure)
    || answer.status === 409 && code === 'work_has_parts') return { status: 'absent' };
  return { status: 'failed', answer };
}
