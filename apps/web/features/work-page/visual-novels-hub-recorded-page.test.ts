import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import record from '../../../../tests/qa/fixtures/outcomes/visual-novels/work-hub-and-edition-choice.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { EditionChoice } from '../tracking/types.ts';
import { booksEditionReads, readBooksEditionPage, readBooksEditionStatus } from './books-edition-page.read.ts';

const row = record as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const choosers = ['member', 'owner', 'moderator', 'operator'] as const;

function sample(persona: AnswerPersona, label: string) {
  const answer = row.personas[persona].find(item => item.label === label);
  if (!answer) throw new Error(`Missing recorded answer: ${row.row}/${persona}/${label}`);
  return answer;
}

function transport(persona: AnswerPersona, selections: RecordedSelection[], failures: string[] = []) {
  const replay = recordedFetch(row, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await replay.fetcher(input, init); }
    catch (error) { failures.push(String(error)); throw error; }
  }) as typeof fetch;
  return browserMainApi('https://recorded.invalid', { fetcher });
}

function workId(persona: AnswerPersona) {
  return new URL(sample(persona, 'primary-get-works-0').path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
}

function subjectOf(persona: AnswerPersona, label: string) {
  return new URL(sample(persona, label).path, 'https://recorded.invalid').searchParams.get('actingSubject') ?? undefined;
}

function command(persona: AnswerPersona, label: string) {
  const answer = sample(persona, label);
  const { actingSubject, expectedVersion, ...choice } = answer.body as EditionChoice & {
    actingSubject: string; expectedVersion: number;
  };
  return { answer, actingSubject, expectedVersion, choice, work: (sample(persona, 'primary-get-works-0').answer as { id: string }).id };
}

for (const persona of personas) {
  test(`${persona}: the production Work reader consumes the recorded Lantern Orchard header`, async () => {
    const header = sample(persona, 'primary-get-works-0');
    const failures: string[] = [];
    const main = transport(persona, [{ label: header.label, state: 'populated' }], failures);
    const reads = booksEditionReads({ main, actingSubject: subjectOf(persona, header.label) });
    expect<unknown>(await reads.readWorkHeader(workId(persona))).toEqual({ ok: true, data: header.answer });
    expect(failures).toEqual([]);
  });

  test(`${persona}: another person's edition preference stays the recorded refusal`, async () => {
    const refused = sample(persona, 'primary-get-me-edition-preferences-0');
    const failures: string[] = [];
    const main = transport(persona, [{ label: refused.label, state: 'error' }], failures);
    const reads = booksEditionReads({ main, actingSubject: subjectOf(persona, refused.label) });
    expect<unknown>(await reads.readEditionPreference(workId(persona))).toEqual({
      ok: false, failure: 'sign-in', status: refused.status, problem: refused.answer,
    });
    expect(failures).toEqual([]);
  });

  test(`${persona}: saving another person's edition preference is refused`, async () => {
    const label = 'primary-put-me-edition-preferences-0';
    const { answer, actingSubject, expectedVersion, choice, work } = command(persona, label);
    const failures: string[] = [];
    const main = transport(persona, [{ label, state: 'error' }], failures);
    expect(await mainTrackingApi(actingSubject, () => main).setPreference(work, expectedVersion, choice))
      .toEqual({ ok: false, failure: 'sign-in' });
    expect(failures).toEqual([]);
    expect(answer.status === 401 || answer.status === 403).toBe(true);
  });
}

test('member: the edition seam consumes the recorded Work, exact releases and empty preference', async () => {
  const header = sample('member', 'primary-get-works-0');
  const releases = sample('member', 'hub-releases');
  const preference = sample('member', 'primary-get-me-edition-preferences-1');
  const progress = sample('member', 'hub-progress-empty');
  const realizations = sample('member', 'hub-realizations');
  expect(preference.answer).toBeNull();
  const failures: string[] = [];
  const main = transport('member', [
    { label: header.label, state: 'populated' },
    { label: releases.label, state: 'populated' },
    { label: realizations.label, state: 'populated' },
    { label: preference.label, state: 'empty' },
    { label: progress.label, state: 'populated' },
  ], failures);
  const actingSubject = subjectOf('member', header.label)!;
  const id = workId('member');
  const reads = booksEditionReads({ main, actingSubject });
  const page = await readBooksEditionPage(reads, id, 'en');
  expect<unknown>(page.header).toEqual({ ok: true, data: header.answer });
  expect<unknown>(page.releases).toEqual({ ok: true, data: releases.answer });
  expect<unknown>(page.status.preference).toEqual({ ok: true, data: null });
  expect<unknown>(page.status.progress).toEqual({ ok: true, data: progress.answer });
  expect(page.status.editionName).toBeNull();
  const offered = await mainTrackingApi(actingSubject, () => main).editions((header.answer as { id: string }).id);
  expect(offered.ok, failures.join('\n')).toBe(true);
  if (!offered.ok) return;
  const releasePage = releases.answer as { items: unknown; nextCursor: string | null };
  const realizationPage = realizations.answer as { items: unknown; nextCursor: string | null };
  expect(offered.data.releases).toEqual(releasePage.items);
  expect(offered.data.realizations).toEqual(realizationPage.items);
  expect(offered.data.releasesCursor).toBe(releasePage.nextCursor);
  expect(offered.data.realizationsCursor).toBe(realizationPage.nextCursor);
  expect(await mainTrackingApi(actingSubject, () => main).preference((header.answer as { id: string }).id))
    .toEqual({ ok: true, data: null });
  expect(failures).toEqual([]);
});

test('member: the saved realization preference keeps its revision and progress continuation', async () => {
  const preference = sample('member', 'primary-get-me-edition-preferences-3');
  const progress = sample('member', 'primary-get-me-progress-summaries-0');
  const failures: string[] = [];
  const main = transport('member', [
    { label: preference.label, state: 'populated' },
    { label: progress.label, state: 'populated' },
  ], failures);
  const reads = booksEditionReads({ main, actingSubject: subjectOf('member', preference.label) });
  const status = await readBooksEditionStatus(reads, workId('member'), 'en');
  expect<unknown>(status.preference).toEqual({ ok: true, data: preference.answer });
  expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
  expect(status.editionName).toBeNull();
  expect(failures).toEqual([]);
});

for (const persona of choosers) {
  test(`${persona}: a recorded save, replay and compare-and-set keep the exact edition`, async () => {
    for (const label of ['primary-put-me-edition-preferences-1', 'primary-put-me-edition-preferences-2', 'primary-put-me-edition-preferences-3', 'primary-put-me-edition-preferences-4'] as const) {
      const { answer, actingSubject, expectedVersion, choice, work } = command(persona, label);
      const failures: string[] = [];
      const main = transport(persona, [{ label, state: answer.status === 200 ? 'populated' : 'error' }], failures);
      const result = await mainTrackingApi(actingSubject, () => main).setPreference(work, expectedVersion, choice);
      expect(failures, failures.join('\n')).toEqual([]);
      if (answer.status === 200) expect<unknown>(result).toEqual({ ok: true, data: answer.answer });
      else expect<unknown>(result).toEqual({ ok: false, failure: 'stale',
        current: (answer.answer as { current: unknown }).current, submitted: choice });
    }
  });
}
