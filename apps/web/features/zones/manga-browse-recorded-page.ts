import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';

/** The catalogue page's recorded readers. The route chooses the query; these names only select samples. */
export const mangaBrowsePersonas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;

export function recordedSample(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(sample => sample.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

/** The Zone key the site address carries. Every persona resolves the same public key. */
export function recordedSiteKey(record: AnswerRecord): string {
  const key = new URL(recordedSample(record, 'visitor', 'frame-address').path, 'https://recorded.invalid')
    .searchParams.get('key');
  if (!key) throw new Error('Recorded address has no site key');
  return key;
}

/** The production session's acting person. A visitor has none. */
export function recordedActingSubject(record: AnswerRecord, persona: AnswerPersona): string | undefined {
  if (persona === 'visitor') return undefined;
  const answer = recordedSample(record, persona, 'frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  };
  return answer.sessionAgent.actingSubject;
}

/** The page address's search, taken from the recorded production request. */
export function recordedSearch(record: AnswerRecord, persona: AnswerPersona, label: string): Record<string, string> {
  return Object.fromEntries(new URL(recordedSample(record, persona, label).path, 'https://recorded.invalid').searchParams);
}

/**
 * Frame reads the site browse route makes, plus the page sample.
 * A missing browse mount is the recorded 404. Signed-in reads follow the session person.
 * The header refetches follow state only for a persona whose recorded follow has no level or following.
 */
export function recordedFrameLabels(record: AnswerRecord, persona: AnswerPersona, label: string): string[] {
  const followState = record.personas[persona].filter(sample => sample.label === 'frame-follow-state').length === 1
    ? ['frame-follow-state'] : [];
  return ['frame-address', 'frame-presentation', 'frame-routes', 'frame-realm-header', 'frame-facets', label,
    ...(persona === 'visitor' ? [] : ['frame-session-agent', 'frame-person-preferences', 'frame-joining',
      'frame-member-ban', 'frame-follow', 'frame-platform-access']),
    ...followState];
}
