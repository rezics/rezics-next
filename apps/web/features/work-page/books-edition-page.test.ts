import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import hub from '../../../../tests/qa/fixtures/outcomes/books/work-hub-and-edition-choice.json';
import ambiguous from '../../../../tests/qa/fixtures/outcomes/books/choose-among-ambiguous-editions-of-one-work-ambiguous-editions.json';
import formats from '../../../../tests/qa/fixtures/outcomes/books/choose-among-mixed-formats-mixed-formats.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { EditionChoice, Editions } from '../tracking/types.ts';
import { booksEditionReads, readBooksEditionStatus } from './books-edition-page.read.ts';

const records = [hub, ambiguous, formats] as AnswerRecord[];
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const answer = record.personas[persona].find(item => item.label === label);
  if (!answer) throw new Error(`Missing recorded answer: ${record.row}/${persona}/${label}`);
  return answer;
}

function transport(record: AnswerRecord, persona: AnswerPersona, selections: RecordedSelection[], failures: string[] = []) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await replay.fetcher(input, init); }
    catch (error) { failures.push(String(error)); throw error; }
  }) as typeof fetch;
  return browserMainApi('https://recorded.invalid', { fetcher });
}

function command(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const answer = sample(record, persona, label);
  const { actingSubject, expectedVersion, ...choice } = answer.body as EditionChoice & {
    actingSubject: string; expectedVersion: number;
  };
  const work = (sample(record, persona, 'work-header').answer as { id: string }).id;
  return { answer, actingSubject, expectedVersion, choice, work };
}

for (const record of records) {
  test(`${record.row}: the saved status resolves its exact release without an inventory page`, async () => {
    const hubRow = record === records[0];
    const sameTitleRow = record === records[1];
    const own = sample(record, 'member', hubRow ? 'own-preference-paperback'
      : sameTitleRow ? 'own-preference-audiobook' : 'own-preference-ebook');
    const release = sample(record, 'member', hubRow ? 'release-detail-paperback'
      : sameTitleRow ? 'selected-release-audiobook' : 'selected-release-ebook');
    const progress = sample(record, 'member', 'progress-in-language');
    const failures: string[] = [];
    const main = transport(record, 'member', [
      { label: own.label, state: 'populated' }, { label: release.label, state: 'populated' },
      { label: progress.label, state: 'populated' },
    ], failures);
    const url = new URL(own.path, 'https://recorded.invalid');
    const id = url.pathname.split('/').at(-1)!;
    const reads = booksEditionReads({ main, actingSubject: url.searchParams.get('actingSubject')! });
    const status = await readBooksEditionStatus(reads, id, 'en');
    expect<unknown>(status.preference).toEqual({ ok: true, data: own.answer });
    expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
    const detail = release.answer as { id: string; title: { value: string }; editionStatement: string };
    expect(status.editionName).toContain(detail.title.value);
    expect(status.editionName).toContain(detail.editionStatement);
    expect<unknown>(await reads.readEditionRelease(id, detail.id)).toEqual({ ok: true, data: release.answer });
    expect(failures).toEqual([]);
  });

  test(`${record.row}: the server page seam consumes the same recorded Work and public releases`, async () => {
    const header = sample(record, 'member', 'work-header');
    const preference = sample(record, 'member', 'own-preference-before');
    const releases = sample(record, 'member', record === records[0] ? 'availability-releases' : 'release-choices');
    const main = transport(record, 'member', [
      { label: header.label, state: 'populated' }, { label: releases.label, state: 'populated' },
      { label: preference.label, state: 'empty' },
    ]);
    const actingSubject = new URL(header.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
    const id = new URL(header.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    const reads = booksEditionReads({ main, actingSubject });
    expect<unknown>(await reads.readWorkHeader(id)).toEqual({ ok: true, data: header.answer });
    expect<unknown>(await reads.readReleases(id)).toEqual({ ok: true, data: releases.answer });
    expect<unknown>(await reads.readEditionPreference(id)).toEqual({ ok: true, data: preference.answer });
  });

  test(`${record.row}: the server preference reader retains the recorded visitor refusal`, async () => {
    const refused = sample(record, 'visitor', 'preference-sign-in');
    const main = transport(record, 'visitor', [{ label: refused.label, state: 'error' }]);
    const url = new URL(refused.path, 'https://recorded.invalid');
    const reads = booksEditionReads({ main, actingSubject: url.searchParams.get('actingSubject')! });
    expect<unknown>(await reads.readEditionPreference(url.pathname.split('/').at(-1)!)).toEqual({
      ok: false, failure: 'sign-in', status: refused.status, problem: refused.answer,
    });
  });
  test(`${record.row}: the production reader consumes the recorded offered editions`, async () => {
    const persona = 'member';
    const own = sample(record, persona, 'own-preference-before');
    const actingSubject = new URL(own.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
    const work = (sample(record, persona, 'work-header').answer as { id: string }).id;
    const releaseLabel = record === records[0] ? 'availability-releases' : 'release-choices';
    const failures: string[] = [];
    const main = transport(record, persona, [
      { label: 'realization-choices', state: 'populated' }, { label: releaseLabel, state: 'populated' },
    ], failures);
    const result = await mainTrackingApi(actingSubject, () => main).editions(work);
    expect(result.ok, failures.join('\n')).toBe(true);
    if (!result.ok) return;
    const realizations = sample(record, persona, 'realization-choices').answer as {
      items: Editions['realizations']; nextCursor: string | null;
    };
    const releases = sample(record, persona, releaseLabel).answer as {
      items: Editions['releases']; nextCursor: string | null;
    };
    expect(result.data.realizations).toEqual(realizations.items);
    expect(result.data.releases).toEqual(releases.items);
    expect(result.data.realizationsCursor).toBe(realizations.nextCursor);
    expect(result.data.releasesCursor).toBe(releases.nextCursor);
  });

  test(`${record.row}: a recorded null preference is a successful empty read`, async () => {
    const own = sample(record, 'member', 'own-preference-before');
    expect(own.answer).toBeNull();
    const actingSubject = new URL(own.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
    const work = (sample(record, 'member', 'work-header').answer as { id: string }).id;
    const main = transport(record, 'member', [{ label: own.label, state: 'empty' }]);
    expect(await mainTrackingApi(actingSubject, () => main).preference(work)).toEqual({ ok: true, data: null });
  });

  test(`${record.row}: a recorded save and compare-and-set conflict retain the exact edition`, async () => {
    for (const label of [record === records[0] ? 'save-preference-paperback' : 'save-preference-ebook', 'save-preference-stale']) {
      const { answer, actingSubject, expectedVersion, choice, work } = command(record, 'member', label);
      const main = transport(record, 'member', [{ label, state: answer.status === 200 ? 'populated' : 'error' }]);
      const result = await mainTrackingApi(actingSubject, () => main).setPreference(work, expectedVersion, choice);
      if (answer.status === 200) expect<unknown>(result).toEqual({ ok: true, data: answer.answer });
      else expect<unknown>(result).toEqual({ ok: false, failure: 'stale',
        current: (answer.answer as { current: unknown }).current, submitted: choice });
    }
  });

  test(`${record.row}: visitors cannot save and every signed-in persona is refused another Person's choice`, async () => {
    for (const persona of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
      const label = persona === 'visitor' ? 'save-preference-sign-in' : 'foreign-save-preference-denied';
      const { actingSubject, expectedVersion, choice, work } = command(record, persona, label);
      const main = transport(record, persona, [{ label, state: 'error' }]);
      expect(await mainTrackingApi(actingSubject, () => main).setPreference(work, expectedVersion, choice))
        .toEqual({ ok: false, failure: 'sign-in' });
    }
  });
}

test('the Work hub progress summary retains the recorded saved edition and continuations', async () => {
  const record = records[0]!;
  const own = sample(record, 'member', 'own-preference-paperback');
  const progress = sample(record, 'member', 'own-progress-summary');
  const actingSubject = new URL(own.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
  const work = (sample(record, 'member', 'work-header').answer as { id: string }).id;
  const main = transport(record, 'member', [
    { label: own.label, state: 'populated' }, { label: progress.label, state: 'populated' },
  ]);
  const api = mainTrackingApi(actingSubject, () => main);
  expect<unknown>(await api.preference(work)).toEqual({ ok: true, data: own.answer });
  expect<unknown>(await api.series(work)).toEqual({ ok: true, data: progress.answer });
  const reads = booksEditionReads({ main, actingSubject });
  expect<unknown>(await reads.readProgressSummary(work.slice(-36))).toEqual({ ok: true, data: progress.answer });
});

test('an unknown saved Release language is omitted from both progress request owners', async () => {
  const record = records[0]!;
  const own = sample(record, 'member', 'own-preference-paperback');
  const progress = sample(record, 'member', 'own-progress-summary');
  const original = new URL(own.path, 'https://recorded.invalid');
  const actingSubject = original.searchParams.get('actingSubject')!;
  const work = (sample(record, 'member', 'work-header').answer as { id: string }).id;
  const requests: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    return Response.json(progress.answer);
  }) as typeof fetch;
  const main = browserMainApi('https://recorded.invalid', { fetcher });
  const reads = booksEditionReads({ main, actingSubject });
  expect<unknown>(await reads.readProgressSummary(work.slice(-36), null)).toEqual({ ok: true, data: progress.answer });
  expect<unknown>(await mainTrackingApi(actingSubject, () => main).series(work, null))
    .toEqual({ ok: true, data: progress.answer });
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.pathname).toEndWith(`/progress-summaries/${work.slice(-36)}`);
    expect([...request.searchParams]).toEqual([['actingSubject', actingSubject]]);
  }
});
