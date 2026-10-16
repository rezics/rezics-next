import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';

export type AttachmentVisit = 'inventory' | 'delegated' | 'revoked' | 'bare';

/** Select answers only; production owns the requests, page size and mapping. */
export function attachmentSelections(record: AnswerRecord, persona: AnswerPersona, visit: AttachmentVisit, loading = false): RecordedSelection[] {
  return record.personas[persona].filter(sample => !sample.label.includes('@') && (
    /^(session|frame)-/.test(sample.label) || sample.label.startsWith(`${visit}-`)
    || visit === 'revoked' && sample.label === 'delegated-0'
  )).map(sample => ({ label: sample.label, state: loading && sample.label === `${visit}-0` ? 'loading'
    : sample.status >= 400 ? 'error' : 'populated' }));
}

export function attachmentIdentity(record: AnswerRecord, persona: AnswerPersona) {
  const sample = (persona === 'visitor' ? record.personas.owner : record.personas[persona])
    .find(item => item.label === 'inventory-0');
  if (!sample) throw new Error('Recorded attachment inventory is absent');
  const url = new URL(sample.path, 'https://recorded.invalid');
  return { realm: url.pathname.split('/')[3]!, actingSubject: url.searchParams.get('actingSubject')! };
}
