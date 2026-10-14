import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/anime/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { createReaderStore, readReaderSeed } from '../catalogue/reader-store.ts';
import { readCustomShelves } from '../library/read.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from './api.ts';
import { problemTitle, readAnimeEpisodeResume, type AnimeResumeFact } from './anime-collection-recorded-page.ts';
import { mainEpisodeApi } from './episode-api.ts';
import { mainMediaApi } from './media-api.ts';

const record = collectionRecord as unknown as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

interface Seen { method: string; path: string; body: unknown }
const signedIn = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`missing recorded sample ${persona}/${label}`);
  return found;
}

function watchedFetch(replay: ReturnType<typeof recordedFetch>, seen: Seen[]): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input instanceof Request ? input.clone() : new URL(String(input), 'https://recorded.invalid'), init);
    const url = new URL(request.url);
    const text = await request.clone().text();
    seen.push({
      method: request.method,
      path: url.pathname.replace(/^\/api\/main/, '') + url.search,
      body: text ? JSON.parse(text) as unknown : undefined,
    });
    return replay.fetcher(input, init);
  }, { preconnect: fetch.preconnect });
}

function client(persona: AnswerPersona, selections: { label: string; state: RecordedState }[], seen: Seen[], anonymous = false) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  return browserMainApi('https://recorded.invalid', { anonymous, fetcher: watchedFetch(replay, seen) });
}

/** Query parameters match by name. Callers do not share one parameter order. */
function expectSameRequest(actual: string, expected: string) {
  const left = new URL(actual, 'https://recorded.invalid');
  const right = new URL(expected, 'https://recorded.invalid');
  const pairs = (url: URL) => [...url.searchParams.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  expect({ path: left.pathname, query: pairs(left) }).toEqual({ path: right.pathname, query: pairs(right) });
}

function workOf(persona: AnswerPersona) {
  const work = (sample(persona, 'episode-opening-page').answer as { work?: string }).work;
  if (!work) throw new Error(`recorded opening names no Work for ${persona}`);
  return work;
}

function subjectOf(persona: (typeof signedIn)[number]) {
  const actingSubject = new URL(sample(persona, 'start-watching').path, 'https://recorded.invalid').searchParams.get('actingSubject')
    ?? (sample(persona, 'start-watching').body as { actingSubject?: string }).actingSubject;
  if (!actingSubject) throw new Error(`recorded shelf write names no reader for ${persona}`);
  return actingSubject;
}

test('episode opening keeps the recorded limit of 20', async () => {
  const visitorSeen: Seen[] = [];
  const visitorSample = sample('visitor', 'episode-opening-page');
  const visitor = client('visitor', [{ label: 'episode-opening-page', state: 'populated' }], visitorSeen, true);
  expect((await mainMediaApi(undefined as unknown as string, () => visitor).positions(workOf('visitor'))).ok).toBe(true);
  expect(visitorSeen.map(item => item.body)).toEqual([undefined]);
  expect(visitorSeen[0]?.method).toBe('GET');
  expectSameRequest(visitorSeen[0]!.path, visitorSample.path);
  expect((visitorSample.answer as { items: { displayLabel: string }[] }).items.map(item => item.displayLabel))
    .toEqual(['Episode 1', 'Episode 2', 'Episode 3']);

  for (const persona of signedIn) {
    const seen: Seen[] = [];
    const chosen = sample(persona, 'episode-opening-page');
    const main = client(persona, [{ label: 'episode-opening-page', state: 'populated' }], seen);
    expect((await mainMediaApi(subjectOf(persona), () => main).positions(workOf(persona))).ok).toBe(true);
    expect(seen.map(item => item.body)).toEqual([undefined]);
    expect(seen[0]?.method).toBe('GET');
    expectSameRequest(seen[0]!.path, chosen.path);
  }
});

test('a signed-in resume keeps the recorded episode and the mine query', async () => {
  const chosen = sample('member', 'resume-watching');
  const seen: Seen[] = [];
  const actingSubject = subjectOf('member');
  const work = workOf('member');
  const main = client('member', [{ label: 'resume-watching', state: 'populated' }], seen);
  const fact = await readAnimeEpisodeResume(main, actingSubject, work);
  const loaded = await mainEpisodeApi(actingSubject, () => main).resume(work);
  expect(seen.map(item => item.path)).toEqual([chosen.path, chosen.path]);
  expect(seen.every(item => item.method === 'GET' && item.body === undefined)).toBe(true);
  const answer = chosen.answer as { work: string; items: { occurrence: string; displayLabel: string }[]; scope: string; complete: boolean };
  expect(fact).toEqual({
    kind: 'place', work: answer.work, occurrence: answer.items[0]!.occurrence, label: answer.items[0]!.displayLabel,
  } satisfies AnimeResumeFact);
  expect(loaded).toEqual({ ok: true, data: { occurrence: answer.items[0]!.occurrence, label: answer.items[0]!.displayLabel } });
  expect(answer.scope).toBe('resume');
  expect(answer.complete).toBe(true);
});

test('the shelf write reads reader state before it sends the recorded status', async () => {
  const chosen = sample('member', 'start-watching');
  const prior = sample('member', 'reader-state-before-watching');
  const seen: Seen[] = [];
  const actingSubject = subjectOf('member');
  const work = workOf('member');
  const main = client('member', [
    { label: 'collection-reader-seed', state: 'populated' },
    { label: 'reader-state-before-watching', state: 'populated' },
    { label: 'start-watching', state: 'populated' },
  ], seen);
  expect(await readReaderSeed(main, actingSubject, [work])).not.toBeNull();
  const saved = await createReaderStore({ actingSubject, main: () => main }).setStatus(work, 'reading');
  expect(saved).toBe(true);
  expect(seen.map(item => ({ method: item.method, path: item.path, body: item.body }))).toEqual([
    { method: 'GET', path: sample('member', 'collection-reader-seed').path, body: undefined },
    { method: 'GET', path: prior.path, body: undefined },
    { method: 'PUT', path: chosen.path, body: chosen.body },
  ]);
  const answer = chosen.answer as { status: string; version: number; replayed: boolean; work: string };
  expect(answer).toMatchObject({ work, status: 'reading', version: 1, replayed: false });
});

test('marking an episode reads its progress and then writes the recorded body', async () => {
  const before = sample('member', 'episode-progress-before-completion');
  const written = sample('member', 'episode-completed');
  const seen: Seen[] = [];
  const actingSubject = subjectOf('member');
  const url = new URL(before.path, 'https://recorded.invalid');
  const match = /\/compositions\/([^/]+)\/occurrences\/([^/]+)\/progress$/.exec(url.pathname);
  if (!match) throw new Error('recorded progress names no occurrence');
  const episode = { structure: match[1]!, occurrence: match[2]! };
  const main = client('member', [
    { label: 'episode-progress-before-completion', state: 'populated' },
    { label: 'episode-completed', state: 'populated' },
  ], seen);
  const marked = await mainEpisodeApi(actingSubject, () => main).mark(episode, { completed: true, position: null });
  expect(seen.map(item => ({ method: item.method, path: item.path, body: item.body }))).toEqual([
    { method: 'GET', path: before.path, body: undefined },
    { method: 'PUT', path: written.path, body: written.body },
  ]);
  const answer = written.answer as { occurrence: string; completed: boolean; version: number; position: null; replayed: boolean };
  expect(marked).toMatchObject({ ok: true, data: { completed: true, position: null, version: 1 } });
  expect(answer).toMatchObject({ occurrence: `https://rezics.com/id/${episode.occurrence}`, completed: true, version: 1, position: null, replayed: false });
  const prior = before.answer as { completed: boolean; version: number; position: null };
  expect(prior).toMatchObject({ completed: false, version: 0, position: null });
});

test('a missing equivalence definition keeps the recorded problem title', async () => {
  const chosen = sample('member', 'collection-equivalence-definition');
  const seen: Seen[] = [];
  const main = client('member', [{ label: 'collection-equivalence-definition', state: 'error' }], seen);
  const result = await mainTrackingApi(subjectOf('member'), () => main).definition('correspondence-equivalent');
  expect(seen).toEqual([{ method: 'GET', path: chosen.path, body: undefined }]);
  expect(result).toEqual({ ok: false, failure: 'missing' });
  expect(problemTitle(chosen.answer)).toBe('Definition is unavailable');
  expect((chosen.answer as { code: string }).code).toBe('definition_unavailable');
});

test('each signed-in reader loads the recorded shelf page of 20', async () => {
  for (const persona of signedIn) {
    const chosen = sample(persona, 'collection-custom-shelves');
    const seen: Seen[] = [];
    const main = client(persona, [{ label: 'collection-custom-shelves', state: 'populated' }], seen);
    const shelves = await readCustomShelves(main, subjectOf(persona));
    expect(seen).toEqual([{ method: 'GET', path: chosen.path, body: undefined }]);
    expect(shelves.ok && shelves.data.items).toEqual([]);
    expect(chosen.path).toContain('limit=20');
  }
});
