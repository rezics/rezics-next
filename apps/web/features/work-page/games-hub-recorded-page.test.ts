import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import games from '../../../../tests/qa/fixtures/outcomes/games/work-hub-and-edition-choice.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { EditionChoice } from '../tracking/types.ts';
import { booksEditionReads, readBooksEditionStatus } from './books-edition-page.read.ts';

// The production releases read always sends limit=20. This row records that list
// without the parameter, so the reader cannot consume it. The exact release is
// read by its own address, which the record does contain.

const record = games as AnswerRecord;
const signedIn = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string) {
  const answer = record.personas[persona].find(item => item.label === label);
  if (!answer) throw new Error(`Missing recorded answer: ${record.row}/${persona}/${label}`);
  return answer;
}

function transport(persona: AnswerPersona, selections: RecordedSelection[]) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  return browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor', fetcher: replay.fetcher });
}

function subjectOf(persona: AnswerPersona, label = 'work-header') {
  return new URL(sample(persona, label).path, 'https://recorded.invalid').searchParams.get('actingSubject');
}

function workId(persona: AnswerPersona) {
  return new URL(sample(persona, 'work-header').path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
}

function command(persona: AnswerPersona, label: string) {
  const answer = sample(persona, label);
  const { actingSubject, expectedVersion, ...choice } = answer.body as EditionChoice & {
    actingSubject: string; expectedVersion: number;
  };
  const work = (sample(persona, 'work-header').answer as { id: string }).id;
  return { answer, actingSubject, expectedVersion, choice, work };
}

test('every persona reads the recorded game', async () => {
  for (const persona of ['visitor', ...signedIn] as const) {
    const header = sample(persona, 'work-header');
    const main = transport(persona, [{ label: header.label, state: 'populated' }]);
    const actingSubject = subjectOf(persona) ?? undefined;
    const reads = booksEditionReads({ main, actingSubject });
    expect<unknown>(await reads.readWorkHeader(workId(persona))).toEqual({ ok: true, data: header.answer });
    expect((header.answer as { title: { value: string } }).title.value).toBe('Original garden game');
  }
});

test('the exact recorded release is readable by its own address', async () => {
  for (const persona of ['visitor', ...signedIn] as const) {
    const release = sample(persona, 'release-details');
    const main = transport(persona, [{ label: release.label, state: 'populated' }]);
    const url = new URL(release.path, 'https://recorded.invalid');
    const reads = booksEditionReads({ main, actingSubject: url.searchParams.get('actingSubject') ?? undefined });
    const id = url.pathname.split('/').at(-3)!;
    expect<unknown>(await reads.readEditionRelease(id, url.pathname.split('/').at(-1)!))
      .toEqual({ ok: true, data: release.answer });
  }
});

test('a signed-in reader’s empty preference is a successful null read', async () => {
  for (const persona of signedIn) {
    const own = sample(persona, 'preference-empty');
    expect(own.answer).toBeNull();
    const actingSubject = subjectOf(persona, 'preference-empty')!;
    const work = (sample(persona, 'work-header').answer as { id: string }).id;
    const main = transport(persona, [{ label: own.label, state: 'empty' }]);
    const reads = booksEditionReads({ main, actingSubject });
    expect<unknown>(await reads.readEditionPreference(workId(persona))).toEqual({ ok: true, data: null });
    expect(await mainTrackingApi(actingSubject, () => main).preference(work)).toEqual({ ok: true, data: null });
  }
});

test('the member status names the recorded release and keeps the recorded progress', async () => {
  const saved = sample('member', 'preference-saved');
  const release = sample('member', 'release-details');
  const progress = sample('member', 'progress-summary');
  const actingSubject = subjectOf('member')!;
  const main = transport('member', [
    { label: saved.label, state: 'populated' }, { label: release.label, state: 'populated' },
    { label: progress.label, state: 'populated' },
  ]);
  const reads = booksEditionReads({ main, actingSubject });
  const status = await readBooksEditionStatus(reads, workId('member'), 'en');
  expect<unknown>(status.preference).toEqual({ ok: true, data: saved.answer });
  expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
  const detail = release.answer as { id: string; revision: string; title: { value: string }; editionStatement: string };
  const preference = saved.answer as { edition: { kind: string; resource: string; revision: string } };
  expect(preference.edition).toEqual({ kind: 'release', resource: detail.id, revision: detail.revision });
  expect(status.editionName).toContain(detail.title.value);
  expect(status.editionName).toContain(detail.editionStatement);
  expect(detail.title.value).toBe('Garden game desktop release');
});

test('a signed-in reader saves only the recorded release on their own Person', async () => {
  for (const persona of signedIn) {
    const { answer, actingSubject, expectedVersion, choice, work } = command(persona, 'choose-edition');
    const main = transport(persona, [{ label: 'choose-edition', state: 'populated' }]);
    expect<unknown>(await mainTrackingApi(actingSubject, () => main).setPreference(work, expectedVersion, choice))
      .toEqual({ ok: true, data: answer.answer });
    const saved = sample(persona, 'preference-saved').answer as {
      edition: { kind: 'release'; resource: string; revision: string }; version: number;
    };
    const written = answer.answer as {
      edition: typeof saved.edition; version: number; replayed: boolean;
    };
    expect<unknown>(written.edition).toEqual(saved.edition);
    expect(written.version).toBe(saved.version);
    expect(written.replayed).toBe(false);
    expect<unknown>(choice.edition).toEqual(saved.edition);
  }
});

test('a visitor is refused the preference, and an unpublished game stays withheld', async () => {
  const refused = sample('visitor', 'preference-sign-in');
  const url = new URL(refused.path, 'https://recorded.invalid');
  const main = transport('visitor', [{ label: refused.label, state: 'error' }]);
  const reads = booksEditionReads({ main, actingSubject: url.searchParams.get('actingSubject')! });
  expect<unknown>(await reads.readEditionPreference(url.pathname.split('/').at(-1)!)).toEqual({
    ok: false, failure: 'sign-in', status: refused.status, problem: refused.answer,
  });
  const missing = sample('visitor', 'unpublished-work');
  const hidden = new URL(missing.path, 'https://recorded.invalid');
  const publicMain = transport('visitor', [{ label: missing.label, state: 'error' }]);
  expect<unknown>(await booksEditionReads({ main: publicMain }).readWorkHeader(hidden.pathname.split('/').at(-1)!))
    .toEqual({ ok: false, failure: 'missing', status: missing.status, problem: missing.answer });
  expect((refused.answer as { title: string }).title).toBe('Account assertion is invalid or inactive');
  expect((missing.answer as { title: string }).title).toBe('Resource is unavailable');
});

test('visitors cannot save, and every signed-in persona is refused another Person’s choice', async () => {
  const denied = command('visitor', 'choose-edition-sign-in');
  const visitor = transport('visitor', [{ label: 'choose-edition-sign-in', state: 'error' }]);
  expect(await mainTrackingApi(denied.actingSubject, () => visitor).setPreference(denied.work, denied.expectedVersion, denied.choice))
    .toEqual({ ok: false, failure: 'sign-in' });
  for (const persona of signedIn) {
    const foreign = sample(persona, 'preference-private');
    const url = new URL(foreign.path, 'https://recorded.invalid');
    const actingSubject = url.searchParams.get('actingSubject')!;
    const main = transport(persona, [{ label: foreign.label, state: 'error' },
      { label: 'choose-edition-private', state: 'error' }]);
    const reads = booksEditionReads({ main, actingSubject });
    expect<unknown>(await reads.readEditionPreference(url.pathname.split('/').at(-1)!)).toEqual({
      ok: false, failure: 'sign-in', status: foreign.status, problem: foreign.answer,
    });
    expect((foreign.answer as { title: string; code: string }).code).toBe('progress_denied');
    const save = command(persona, 'choose-edition-private');
    expect(save.actingSubject).not.toBe(subjectOf(persona));
    expect(await mainTrackingApi(save.actingSubject, () => main).setPreference(save.work, save.expectedVersion, save.choice))
      .toEqual({ ok: false, failure: 'sign-in' });
  }
});

test('the owner reads the recorded unpublished draft', async () => {
  const draft = sample('owner', 'unpublished-work');
  const url = new URL(draft.path, 'https://recorded.invalid');
  const main = transport('owner', [{ label: draft.label, state: 'populated' }]);
  const reads = booksEditionReads({ main, actingSubject: url.searchParams.get('actingSubject')! });
  expect<unknown>(await reads.readWorkHeader(url.pathname.split('/').at(-1)!)).toEqual({ ok: true, data: draft.answer });
  expect((draft.answer as { title: { value: string } }).title.value).toBe('Unpublished garden draft');
});
