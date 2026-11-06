export type ScoreOrderReadState = 'preparing' | 'score-unavailable';

export type PersonalScoreWriteResult = 'successful' | 'rejected' | 'uncertain' | 'stale';

export type PersonalScoreWriteCommand = { units: number | null; key: string };

export function scoreOrderReadState(detail: string | undefined): ScoreOrderReadState | undefined {
  if (!detail) return undefined;
  if (detail.includes('libraryShelfScorePreparation')) return 'preparing';
  if (
    detail.includes('identity fence') ||
    detail.includes('score identity') ||
    detail.includes('score currentness') ||
    detail.includes('voter standing')
  )
    return 'score-unavailable';
  return undefined;
}

/** Reuse the original command key while the same units stay unresolved. */
export function personalScoreWriteCommand(
  pending: PersonalScoreWriteCommand | null,
  units: number | null,
): PersonalScoreWriteCommand {
  if (pending && pending.units === units) return pending;
  return { units, key: crypto.randomUUID() };
}

export function personalScoreWriteNotice(result: PersonalScoreWriteResult | boolean): 'uncertain' | 'stale' | undefined {
  if (result === 'uncertain') return 'uncertain';
  if (result === 'stale') return 'stale';
  return undefined;
}

/** Discovery retries uncertain delivery; a stale review must not reuse that command. */
export function personalScoreDiscoveryWrite(
  result: PersonalScoreWriteResult,
): Exclude<PersonalScoreWriteResult, 'stale'> {
  return result === 'stale' ? 'rejected' : result;
}

export function classifyPersonalScoreWriteProblem(input: {
  status: number;
  code?: string;
  detail?: string;
}): Exclude<PersonalScoreWriteResult, 'successful'> {
  const code = input.code ?? '';
  const detail = input.detail ?? '';
  if (
    input.status === 409 ||
    code === 'vote_review_stale' ||
    detail.includes('subject_changed') ||
    detail.includes('question_changed') ||
    detail.includes('identity_epoch_changed')
  )
    return 'stale';
  if ([400, 401, 403, 404, 422].includes(input.status)) return 'rejected';
  return 'uncertain';
}
