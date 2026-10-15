import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import captured from '../../../../tests/qa/fixtures/outcomes/recipes/instructions-in-any-form.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import type { RecipeWorkPage, WorkHeader } from '../work-page/types.ts';

export const instructionRecord = captured as AnswerRecord;
export function instructionVisitIdentity(persona: AnswerPersona) {
  const samples = instructionRecord.personas[persona];
  const header = samples.find(sample => sample.label.startsWith('reading-visit-') && /^\/v1\/works\/[^/?]+(?:\?|$)/.test(sample.path));
  const page = samples.find(sample => sample.label.startsWith('reading-visit-') && sample.path.startsWith('/v1/recipes/works/'));
  if (!header || !page) throw new Error(`Incomplete recorded instruction visit: ${persona}`);
  const url = new URL(header.path, 'https://recorded.invalid');
  return { id: url.pathname.split('/').pop()!, actingSubject: url.searchParams.get('actingSubject'),
    header: header.answer as WorkHeader, page: page.answer as RecipeWorkPage };
}

/** Transport and captured identity only. The production page and editor own every read and mapping. */
export function instructionVisitTransport(persona: AnswerPersona, origin: string,
  readBinary: (source: string) => Promise<Uint8Array>, onMiss: (error: unknown) => void, loading = false) {
  const samples = instructionRecord.personas[persona];
  const selected = samples.filter(sample => /^(frame|reading|editor|exchange)-visit-/.test(sample.label) || sample.label === 'recording-bytes');
  const selections = selected.map(sample => ({ label: sample.label,
    state: loading && sample.label.startsWith('reading-visit-') && sample.path.startsWith('/v1/recipes/works/')
      ? 'loading' as const : sample.status >= 400 ? 'error' as const : 'populated' as const }));
  const replay = recordedFetch(instructionRecord, persona, selections, { pathPrefix: BFF_PREFIX, sequence: true, readBinary });
  const fetcher = (async (input, init) => {
    try { return await replay.fetcher(input, init); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) onMiss(error); throw error; }
  }) as typeof fetch;
  const main = browserMainApi(origin, { anonymous: persona === 'visitor', fetcher });
  const anonymous = browserMainApi(origin, { anonymous: true, fetcher });
  const identity = instructionVisitIdentity(persona);
  return { ...identity, main, fetcher, dispose: replay.dispose,
    host: { main, anonymous, publicOrigin: origin, publicFetch: fetcher, recordingFetch: fetcher,
      actingSubject: identity.actingSubject, signedIn: persona !== 'visitor' } };
}

export function instructionSamples(persona: AnswerPersona): readonly AnswerSample[] {
  return instructionRecord.personas[persona];
}
