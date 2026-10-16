import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/manga/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../discover/types.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { readAnimeReaderState } from '../work-page/anime-hub-recorded-page.ts';
import { booksEditionReads } from '../work-page/books-edition-page.read.ts';
import { readContentsInventory } from '../work-page/books-contents-recorded-page.tsx';
import { mainMediaApi } from './media-api.ts';

export const mangaDevicePersonas = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;
export type MangaDevicePersona = typeof mangaDevicePersonas[number];
export type MangaDevice = 'first' | 'second';
export type MangaDeviceState = 'replay' | 'undo' | 'after-undo';

export function mangaSample(persona: AnswerPersona, label: string) {
  const sample = (record as AnswerRecord).personas[persona].find(item => item.label === label);
  if (!sample) throw new Error(`Missing recorded sample ${record.row}/${persona}/${label}`);
  return sample;
}

export function mangaWorkId(persona: AnswerPersona, device: MangaDevice = 'first') {
  const sample = mangaSample(persona, device === 'second' ? 'second-undo-1' : 'frame-1');
  return new URL(sample.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
}

export function mangaActingSubject(persona: AnswerPersona): string | undefined {
  return new URL(mangaSample(persona, 'frame-1').path, 'https://recorded.invalid')
    .searchParams.get('actingSubject') ?? undefined;
}

export function mangaFrameSelections(persona: AnswerPersona): RecordedSelection[] {
  return [
    ...Array.from({ length: 7 }, (_, index) => ({ label: `frame-${index + 1}`, state: 'populated' as const })),
    ...(persona === 'visitor' ? [{ label: 'public-contents-1', state: 'populated' as const }]
      : [{ label: 'reader-state-1', state: 'populated' as const }, { label: 'relationships-1', state: 'populated' as const }]),
  ];
}

export function mangaDeviceSelections(device: MangaDevice, state: MangaDeviceState, hold = false): RecordedSelection[] {
  const prefix = state === 'replay' ? 'mark' : `${device}-${state}`;
  const count = state === 'replay' ? 8 : state === 'after-undo' ? 4 : device === 'first' ? 7 : 11;
  return Array.from({ length: count }, (_, index) => ({ label: `${prefix}-${index + 1}`,
    state: hold && index === 1 ? 'loading'
      : state === 'undo' && device === 'second' && index === 5 ? 'error' : 'populated' }));
}

/** Only transport failure is simulated: production owns the retry, its key, and the replayed answer. */
export function mangaRecordedTransport(persona: AnswerPersona, selections: readonly RecordedSelection[], {
  loseAnswer = false, onRequest, onError,
}: {
  loseAnswer?: boolean;
  onRequest?: (request: Request) => void;
  onError?: (error: unknown) => void;
} = {}) {
  const replay = recordedFetch(record as AnswerRecord, persona, selections, { pathPrefix: BFF_PREFIX, sequence: true });
  let drop = loseAnswer;
  const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    onRequest?.(request.clone());
    let response: Response;
    try { response = await replay.fetcher(request); }
    catch (error) { onError?.(error); throw error; }
    if (drop && request.method === 'PUT' && response.ok) {
      drop = false;
      throw new TypeError('Connection lost after save');
    }
    return response;
  }, { preconnect: fetch.preconnect });
  return { fetcher, dispose: replay.dispose };
}

export function mangaRecordedClient(fetcher: typeof fetch, persona: AnswerPersona, origin: string) {
  return browserMainApi(origin, { anonymous: persona === 'visitor', fetcher });
}

/** Bind the existing Work page readers at their client boundary; their mapping also serves the route. */
export async function readMangaDeviceFrame(main: MainClient, persona: AnswerPersona) {
  const id = mangaWorkId(persona), actingSubject = mangaActingSubject(persona);
  const reads = booksEditionReads({ main, actingSubject });
  const [header, agentCredits, credits, classifications, facets, alsoEnjoyed, adoptions, seed] = await Promise.all([
    reads.readWorkHeader(id), reads.readAgentCredits(id), reads.readCredits(id),
    reads.readClassifications(id, { kind: 'global' }), reads.readFacets(), reads.readAlsoEnjoyed(id), reads.readAdoptions(id),
    readAnimeReaderState(main, actingSubject, id),
  ]);
  return { header, agentCredits, credits, classifications, facets, alsoEnjoyed, adoptions, seed, actingSubject };
}

export function readMangaPublicOpening(main: MainClient, persona: AnswerPersona, locale: string) {
  const id = mangaWorkId(persona);
  return readContentsInventory({ main }, { workId: id, workRef: id, workIri: `https://rezics.com/id/${id}`,
    locale, limit: 20 });
}

export function mangaDeviceApi(main: MainClient, persona: MangaDevicePersona) {
  const actor = mangaActingSubject(persona);
  if (!actor) throw new Error(`Recorded signed-in persona has no acting Person: ${persona}`);
  return mainMediaApi(actor, () => main);
}
