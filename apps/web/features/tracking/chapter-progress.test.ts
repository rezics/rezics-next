import { expect, test } from 'bun:test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import bookRecord from '../../../../tests/qa/fixtures/outcomes/books/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import type { Progress } from '../work-page/types.ts';
import type { ReadingPositionPage } from '../wiki/position-picker.ts';
import { mainMediaApi } from './media-api.ts';
import { bookProgressSample, chapterProgressMissingStates, chapterScenarioPersonas, createChapterScenario } from './chapter-progress-fixtures.ts';

for (const persona of chapterScenarioPersonas.filter(value => value !== 'visitor')) {
  test(`Manga ${persona} own devices resume across volumes and omnibus, replay and recover stale undo`, async () => {
    const scenario = createChapterScenario('manga', persona), first = scenario.firstApi!, second = scenario.secondApi!;
    const place = { structure: scenario.selected.structure, occurrence: scenario.selected.occurrence, label: 'Volume 2, chapter 1' };
    const opening = await first.standing(scenario.work);
    expect(opening).toMatchObject({ ok: true, data: { last: { label: 'Volume 1, chapter 2' }, opened: null } });
    expect(await first.positions(scenario.work)).toMatchObject({ ok: true, data: { next: 'volume-two' } });
    const next = await first.positions(scenario.work, 'volume-two');
    expect(next).toMatchObject({ ok: true, data: { items: [place, { label: 'Volume 2, chapter 2' }], next: null } });
    const before = await second.progress(scenario.selected);
    expect(before).toMatchObject({ ok: true, data: { completed: false, version: 0 } });
    const saved = await first.mark(scenario.selected, { completed: true, position: 'read', expectedVersion: 0 });
    expect(saved).toMatchObject({ ok: true, data: { completed: true, version: 1, replayed: true } });
    const puts = scenario.requests.filter(request => request.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0]!.key).toBe(puts[1]!.key);
    expect(puts[0]!.body).toEqual(puts[1]!.body);
    expect(await second.standing(scenario.omnibus!)).toMatchObject({ ok: true, data: { last: place } });
    const stale = await second.mark(scenario.selected, { completed: false, position: null, expectedVersion: 0 });
    expect(stale).toMatchObject({ ok: false, failure: 'stale', status: 409,
      problem: { code: 'stale_progress' }, current: { completed: true, version: 1 } });
    expect(await second.mark(scenario.selected, { completed: false, position: null, expectedVersion: 1 }))
      .toMatchObject({ ok: true, data: { completed: false, position: null, version: 2 } });
    expect(await first.progress(scenario.selected)).toMatchObject({ ok: true, data: { completed: false, version: 2 } });
    expect(await first.standing(scenario.work)).toMatchObject({ ok: true, data: { last: { label: 'Volume 1, chapter 2' } } });
    for (const request of scenario.requests) {
      const subject = request.body ? (request.body as { actingSubject: string }).actingSubject
        : new URL(request.path, 'https://recorded.invalid').searchParams.get('actingSubject');
      expect(subject).toBe(scenario.actingSubject!);
    }
  });
}

test('Book two own devices consume unchanged recorded winning save, stale refusal, recovery and series resume', async () => {
  const scenario = createChapterScenario('book', 'owner'), first = scenario.firstApi!, second = scenario.secondApi!;
  const raw = await scenario.second.v1.compositions({ id: scenario.selected.structure.slice(-36) })
    .occurrences({ occurrence: scenario.selected.occurrence.slice(-36) }).progress.get({ query: { actingSubject: scenario.actingSubject! } });
  expect(raw.data).toEqual(bookProgressSample('device-two-before-save').answer as Progress);
  expect(await second.progress(scenario.selected)).toMatchObject({ ok: true, data: { completed: true, position: null, version: 1 } });
  expect(await first.mark(scenario.selected, { completed: true, position: 'device one paragraph', expectedVersion: 1 }))
    .toEqual({ ok: true, data: bookProgressSample('device-one-save').answer as Progress });
  expect(await second.mark(scenario.selected, { completed: false, position: null, expectedVersion: 1 }))
    .toMatchObject({ ok: false, failure: 'stale', status: 409, problem: bookProgressSample('device-two-stale-save-refused').answer,
      current: { completed: true, position: 'device one paragraph', version: 2 } });
  expect(await second.mark(scenario.selected, { completed: false, position: null, expectedVersion: 2 }))
    .toEqual({ ok: true, data: bookProgressSample('device-two-recovered-save').answer as Progress });
  expect(await first.progress(scenario.selected)).toMatchObject({ ok: true, data: { completed: false, position: null, version: 3 } });
  const replay = recordedFetch(bookRecord as unknown as AnswerRecord, 'owner', [{ label: 'device-two-series-resume', state: 'populated' }], { pathPrefix: BFF_PREFIX });
  try {
    const sample = bookProgressSample('device-two-series-resume'), url = new URL(sample.path, 'https://recorded.invalid');
    const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    const answer = await main.v1['reading-positions']({ work: url.pathname.split('/').at(-1)! }).get({
      query: { position: 'mine', limit: 1, actingSubject: scenario.actingSubject! } });
    expect(answer.data).toEqual(sample.answer as ReadingPositionPage);
    expect(answer.data?.items[0]?.occurrence).toBe(scenario.selected.occurrence);
  } finally { replay.dispose(); }
});

for (const persona of chapterScenarioPersonas.filter(value => value !== 'owner')) {
  test(`Book ${persona} cannot request the foreign recorded Person's progress`, async () => {
    const record = bookRecord as unknown as AnswerRecord;
    const refused = record.personas[persona].find(item => item.label === 'chapter-progress-refused')!;
    const replay = recordedFetch(record, persona, [{ label: refused.label, state: 'error' }], { pathPrefix: BFF_PREFIX });
    try {
      const url = new URL(refused.path, 'https://recorded.invalid'), parts = url.pathname.split('/');
      const foreignSubject = url.searchParams.get('actingSubject')!;
      const page = createChapterScenario('book', persona);
      expect(page.actingSubject).not.toBe(foreignSubject);
      const main = browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor', fetcher: replay.fetcher });
      const answer = await mainMediaApi(foreignSubject, () => main).progress({
        structure: parts[3]!, occurrence: parts[5]!,
      });
      expect(answer).toEqual({ ok: false, failure: 'sign-in', status: persona === 'visitor' ? 401 : 403, problem: refused.answer });
      expect(refused.status).toBe(persona === 'visitor' ? 401 : 403);
    } finally { replay.dispose(); }
  });
}

for (const medium of ['book', 'manga'] as const) {
  test(`${medium} visitors request public contents without a Person or private progress`, async () => {
    const scenario = createChapterScenario(medium, 'visitor');
    expect(scenario.actingSubject).toBeUndefined();
    expect(scenario.firstApi).toBeNull();
    const answer = await scenario.first.v1['reading-positions']({ work: scenario.work.slice(-36) }).get({ query: { position: 'start', limit: 20 } });
    expect(answer.error).toBeNull();
    expect(answer.data?.items.length).toBeGreaterThan(0);
    expect(scenario.requests[0]!.path).not.toContain('actingSubject');
    expect(scenario.requests.some(request => request.path.includes('/progress'))).toBe(false);
  });
    test(`${medium} an empty HTTP 200 is a finished opening inventory`, async () => {
      const scenario = createChapterScenario(medium, 'owner', 'empty');
      const answer = await scenario.firstApi!.standing(scenario.work);
      expect(answer).toMatchObject({ ok: true, data: { last: null, opened: { items: [], next: null } } });
    });
  test(`${medium} missing recordings specify reachable states and exact requests`, () => {
    const missing = chapterProgressMissingStates(medium, 'owner');
    expect(missing.some(item => item.states.includes('error: HTTP 503'))).toBe(true);
    expect(missing.every(item => item.states.every(state => !state.includes('202')))).toBe(true);
    expect(missing.filter(item => item.method === 'PUT').every(item => 'body' in item && item.body?.actingSubject)).toBe(true);
  });
  test(`${medium} a temporarily empty HTTP 200 retains incomplete inventory instead of claiming no chapters`, async () => {
    const scenario = createChapterScenario(medium, 'owner', 'indexing');
    expect(await scenario.firstApi!.standing(scenario.work)).toMatchObject({ ok: true,
      data: { last: null, opened: { items: [], next: null, complete: false } } });
  });
}
