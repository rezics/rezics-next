import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { catalogueRequest, catalogueSample } from './catalogue-browse-records.ts';

export { cataloguePersonas as animeBrowsePersonas } from './catalogue-browse-fixtures.ts';
export const animeBrowseSample = catalogueSample;

export function animeBrowseSiteKey(record: AnswerRecord): string {
  const key = new URL(catalogueSample(record, 'visitor', 'frame-address').path, 'https://recorded.invalid')
    .searchParams.get('key');
  if (!key) throw new Error('The captured Anime visit has no site address');
  return key;
}

export function animeBrowseActor(record: AnswerRecord, persona: AnswerPersona): string | undefined {
  if (persona === 'visitor') return undefined;
  return (catalogueSample(record, persona, 'frame-session-agent').answer as {
    sessionAgent: { actingSubject: string };
  }).sessionAgent.actingSubject;
}

/** Convert wire IRIs and the year Condition back to the address the production route consumes. */
export function animeBrowseSearch(record: AnswerRecord, persona: AnswerPersona, label: string) {
  return catalogueRequest(catalogueSample(record, persona, label).path).search;
}

export function animeBrowseLabels(record: AnswerRecord, persona: AnswerPersona, label: string): string[] {
  return [label, ...record.personas[persona].filter(sample => sample.label.startsWith('frame-')).map(sample => sample.label)];
}
