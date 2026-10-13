import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionRecord from '../../../../tests/qa/fixtures/outcomes/anime/collection-tracking-and-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedState } from '../stories/recorded-fetch.ts';
import { mainEpisodeApi } from './episode-api.ts';
import {
  composeAnimeTracked, mapAnimeReaderStatus, putAnimeReaderStatus, readAnimeEpisodeProgress, readAnimeEpisodeResume,
  readerStatusBody, type AnimeProgressFact, type AnimeResumeFact,
} from './anime-collection-recorded-page.ts';

const record = collectionRecord as unknown as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

interface Seen { method: string; path: string; body: unknown }

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

function resumeTarget(path: string) {
  const url = new URL(path, 'https://recorded.invalid');
  const actingSubject = url.searchParams.get('actingSubject');
  const work = url.pathname.split('/').at(-1);
  if (!actingSubject || !work) throw new Error(`recorded resume names no reader: ${path}`);
  return { actingSubject, work };
}

function progressTarget(path: string) {
  const url = new URL(path, 'https://recorded.invalid');
  const match = /\/compositions\/([^/]+)\/occurrences\/([^/]+)\/progress$/.exec(url.pathname);
  const actingSubject = url.searchParams.get('actingSubject');
  if (!match || !actingSubject) throw new Error(`recorded progress names no occurrence: ${path}`);
  return { structure: match[1]!, occurrence: match[2]!, actingSubject };
}

function statusBody(body: unknown) {
  if (!body || typeof body !== 'object') throw new Error('recorded reader status has no body');
  const value = body as Record<string, unknown>;
  if (typeof value.actingSubject !== 'string' || typeof value.expectedVersion !== 'number'
    || (value.status !== 'reading' && value.status !== 'want-to-read' && value.status !== 'read' && value.status !== null)) {
    throw new Error('recorded reader status is not the shelf write');
  }
  return readerStatusBody(value.actingSubject, value.expectedVersion, value.status);
}

test('a signed-in resume keeps the recorded episode and the mine query', async () => {
  const chosen = sample('member', 'resume-watching');
  const seen: Seen[] = [];
  const { actingSubject, work } = resumeTarget(chosen.path);
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

test('a refused progress read keeps the recorded problem title', async () => {
  const chosen = sample('visitor', 'episode-progress-sign-in');
  const seen: Seen[] = [];
  const target = progressTarget(chosen.path);
  const main = client('visitor', [{ label: 'episode-progress-sign-in', state: 'error' }], seen, true);
  const fact = await readAnimeEpisodeProgress(main, target.actingSubject, target);
  const loaded = await mainEpisodeApi(target.actingSubject, () => main).progress(target);
  expect(seen.map(item => ({ method: item.method, path: item.path, body: item.body }))).toEqual([
    { method: 'GET', path: chosen.path, body: undefined },
    { method: 'GET', path: chosen.path, body: undefined },
  ]);
  const answer = chosen.answer as { title: string; code: string };
  expect(fact).toMatchObject({ kind: 'refusal', failure: 'sign-in', title: answer.title } satisfies Partial<AnimeProgressFact>);
  expect(loaded).toEqual({ ok: false, failure: 'sign-in' });
  expect(answer.code).toBe('account_assertion_denied');
});

test('the shelf write keeps the recorded status, version and body', async () => {
  const chosen = sample('member', 'start-watching');
  const resume = sample('member', 'resume-watching');
  const progress = sample('member', 'own-unstarted-episode');
  const seen: Seen[] = [];
  const main = client('member', [
    { label: 'start-watching', state: 'populated' },
    { label: 'resume-watching', state: 'populated' },
    { label: 'own-unstarted-episode', state: 'populated' },
  ], seen);
  const body = statusBody(chosen.body);
  const { actingSubject, work } = resumeTarget(resume.path);
  expect(body.actingSubject).toBe(actingSubject);
  const status = mapAnimeReaderStatus(await putAnimeReaderStatus(main, work, body, 'recorded-status'));
  const place = await readAnimeEpisodeResume(main, actingSubject, work);
  const episode = progressTarget(progress.path);
  expect(episode.actingSubject).toBe(actingSubject);
  const watched = await readAnimeEpisodeProgress(main, episode.actingSubject, episode);
  expect(seen[0]).toEqual({ method: 'PUT', path: chosen.path, body: chosen.body });
  const answer = chosen.answer as { status: string; version: number; replayed: boolean; work: string };
  expect(status).toEqual({ kind: 'status', work: answer.work, status: answer.status, version: answer.version, replayed: answer.replayed });
  expect(answer.replayed).toBe(false);
  const view = composeAnimeTracked({ persona: 'member', actingPerson: actingSubject, status, resume: place, progress: watched });
  const progressAnswer = progress.answer as { occurrence: string; completed: boolean; version: number; position: null };
  const resumeAnswer = resume.answer as { items: { displayLabel: string; occurrence: string }[]; work: string };
  expect(view).toMatchObject({
    kind: 'tracked',
    persona: 'member',
    actingPerson: actingSubject,
    status: answer.status,
    statusVersion: answer.version,
    work: resumeAnswer.work,
    resumeLabel: resumeAnswer.items[0]!.displayLabel,
    resumeOccurrence: resumeAnswer.items[0]!.occurrence,
    completed: progressAnswer.completed,
    progressVersion: progressAnswer.version,
    progressOccurrence: progressAnswer.occurrence,
    position: progressAnswer.position,
  });
});
