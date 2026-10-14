import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import bookRecord from '../../../../tests/qa/fixtures/outcomes/books/work-hub-and-edition-choice.json';
import record from '../../../../tests/qa/fixtures/outcomes/visual-novels/work-hub-and-edition-choice.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { EditionChoice } from '../tracking/types.ts';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import type { EditionPreference, Release } from '../tracking/types.ts';
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

  // Both hubs use the same preference adapter. Cross-person refusals are captured by the book proof.
  for (const method of ['GET', 'PUT'] as const) {
    test(`${persona}: the shared edition adapter preserves the captured ${method} authority refusal`, async () => {
      const authority = bookRecord as AnswerRecord;
      const refused = authority.personas[persona].find(sample => sample.method === method
        && sample.path.includes('/edition-preferences/') && [401, 403].includes(sample.status))!;
      const replay = recordedFetch(authority, persona, [{ label: refused.label, state: 'error' }], { pathPrefix: BFF_PREFIX });
      disposals.push(replay.dispose);
      const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
      const url = new URL(refused.path, 'https://recorded.invalid');
      const work = url.pathname.split('/').at(-1)!;
      const body = refused.body as EditionChoice & { actingSubject: string; expectedVersion: number };
      const actingSubject = method === 'GET' ? url.searchParams.get('actingSubject')! : body.actingSubject;
      const result = method === 'GET' ? await booksEditionReads({ main, actingSubject }).readEditionPreference(work)
        : await mainTrackingApi(actingSubject, () => main).setPreference(`https://rezics.com/id/${work}`, body.expectedVersion,
          { edition: body.edition, language: body.language });
      expect<unknown>(result).toEqual({ ok: false, failure: 'sign-in', ...(method === 'GET' ? { status: refused.status, problem: refused.answer } : {}) });
    });
  }

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
  expect<unknown>(offered.data.releases).toEqual(releasePage.items);
  expect<unknown>(offered.data.realizations).toEqual(realizationPage.items);
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
    { label: 'saved-realization-detail', state: 'populated' },
  ], failures);
  const reads = booksEditionReads({ main, actingSubject: subjectOf('member', preference.label) });
  const status = await readBooksEditionStatus(reads, workId('member'), 'en');
  expect<unknown>(status.preference).toEqual({ ok: true, data: preference.answer });
  expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
  expect(status.editionName).toBe(copyOf('en').originalText({ language: 'English' }));
  expect(failures).toEqual([]);
});

for (const persona of ['visitor', 'stranger', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: the production release reader consumes the recorded limit-20 page`, async () => {
    const releases = sample(persona, persona === 'visitor' ? 'chooser-releases' : 'visit-chooser-releases');
    const realizations = sample(persona, persona === 'visitor' ? 'chooser-realizations' : 'visit-chooser-realizations');
    const failures: string[] = [];
    const actingSubject = subjectOf(persona, releases.label);
    const main = transport(persona, [
      { label: releases.label, state: 'populated' },
      { label: realizations.label, state: 'populated' },
    ], failures);
    const reads = booksEditionReads({ main, actingSubject });
    expect<unknown>(await reads.readReleases(workId(persona))).toEqual({ ok: true, data: releases.answer });
    if (!actingSubject) {
      expect(failures).toEqual([]);
      return;
    }
    const offered = await mainTrackingApi(actingSubject, () => main).editions((sample(persona, 'primary-get-works-0').answer as { id: string }).id);
    expect(offered.ok, failures.join('\n')).toBe(true);
    if (!offered.ok) return;
    const releasePage = releases.answer as { items: unknown; nextCursor: string | null };
    const realizationPage = realizations.answer as { items: unknown; nextCursor: string | null };
    expect<unknown>(offered.data.releases).toEqual(releasePage.items);
    expect<unknown>(offered.data.realizations).toEqual(realizationPage.items);
    expect(offered.data.releasesCursor).toBe(releasePage.nextCursor);
    expect(offered.data.realizationsCursor).toBe(realizationPage.nextCursor);
    expect(failures).toEqual([]);
  });
}

for (const persona of ['stranger', 'owner', 'moderator', 'operator'] as const) {
  test(`${persona}: the edition seam consumes the recorded Work, exact releases and empty preference`, async () => {
    const header = sample(persona, 'primary-get-works-0');
    const releases = sample(persona, 'visit-chooser-releases');
    const realizations = sample(persona, 'visit-chooser-realizations');
    const preference = sample(persona, persona === 'stranger' ? 'chooser-preference-empty' : 'primary-get-me-edition-preferences-1');
    const progress = sample(persona, 'chooser-progress-empty');
    expect(preference.answer).toBeNull();
    const failures: string[] = [];
    const main = transport(persona, [
      { label: header.label, state: 'populated' },
      { label: releases.label, state: 'populated' },
      { label: realizations.label, state: 'populated' },
      { label: preference.label, state: 'empty' },
      { label: progress.label, state: 'populated' },
    ], failures);
    const actingSubject = subjectOf(persona, header.label)!;
    const reads = booksEditionReads({ main, actingSubject });
    const page = await readBooksEditionPage(reads, workId(persona), 'en');
    expect<unknown>(page.header).toEqual({ ok: true, data: header.answer });
    expect<unknown>(page.releases).toEqual({ ok: true, data: releases.answer });
    expect<unknown>(page.status.preference).toEqual({ ok: true, data: null });
    expect<unknown>(page.status.progress).toEqual({ ok: true, data: progress.answer });
    expect(page.status.editionName).toBeNull();
    expect(failures).toEqual([]);
  });
}

test('member: an empty preference on a Chinese page reads that locale’s progress', async () => {
  const header = sample('member', 'primary-get-works-0');
  const releases = sample('member', 'hub-releases');
  const preference = sample('member', 'primary-get-me-edition-preferences-1');
  const progress = sample('member', 'hub-progress-empty-zh-Hans');
  expect(preference.answer).toBeNull();
  const failures: string[] = [];
  const main = transport('member', [
    { label: header.label, state: 'populated' },
    { label: releases.label, state: 'populated' },
    { label: preference.label, state: 'empty' },
    { label: progress.label, state: 'populated' },
  ], failures);
  const page = await readBooksEditionPage(booksEditionReads({
    main, actingSubject: subjectOf('member', header.label),
  }), workId('member'), 'zh-Hans');
  expect<unknown>(page.status.preference).toEqual({ ok: true, data: null });
  expect<unknown>(page.status.progress).toEqual({ ok: true, data: progress.answer });
  expect(page.status.editionName).toBeNull();
  expect(failures).toEqual([]);
});

for (const persona of choosers) {
  test(`${persona}: the saved release is named from its recorded detail`, async () => {
    const preference = sample(persona, 'primary-get-me-edition-preferences-2');
    const progress = sample(persona, 'chooser-progress-release');
    const detail = sample(persona, 'saved-release-detail');
    const failures: string[] = [];
    const actingSubject = subjectOf(persona, preference.label)!;
    const main = transport(persona, [
      { label: preference.label, state: 'populated' },
      { label: progress.label, state: 'populated' },
      { label: detail.label, state: 'populated' },
    ], failures);
    const reads = booksEditionReads({ main, actingSubject });
    const locale = persona === 'member' ? 'zh-Hans' : 'en';
    const status = await readBooksEditionStatus(reads, workId(persona), locale);
    expect<unknown>(status.preference).toEqual({ ok: true, data: preference.answer });
    expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
    const release = detail.answer as Release;
    expect(status.editionName).toBe(releaseChoiceName(release, locale, copyOf(locale)));
    const saved = preference.answer as EditionPreference;
    expect<unknown>(await mainTrackingApi(actingSubject, () => main).edition(saved.work, saved.edition!))
      .toEqual({ ok: true, data: detail.answer });
    expect(failures).toEqual([]);
  });

  test(`${persona}: the saved realization keeps its revision and recorded detail`, async () => {
    const preference = sample(persona, 'primary-get-me-edition-preferences-3');
    const progress = sample(persona, 'primary-get-me-progress-summaries-0');
    const detail = sample(persona, 'saved-realization-detail');
    const failures: string[] = [];
    const actingSubject = subjectOf(persona, preference.label)!;
    const main = transport(persona, [
      { label: preference.label, state: 'populated' },
      { label: progress.label, state: 'populated' },
      { label: detail.label, state: 'populated' },
    ], failures);
    const reads = booksEditionReads({ main, actingSubject });
    const status = await readBooksEditionStatus(reads, workId(persona), 'en');
    expect<unknown>(status.preference).toEqual({ ok: true, data: preference.answer });
    expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
    expect(status.editionName).toBe(copyOf('en').originalText({ language: 'English' }));
    const saved = preference.answer as EditionPreference;
    expect(saved.edition?.kind).toBe('realization');
    expect<unknown>(await mainTrackingApi(actingSubject, () => main).edition(saved.work, saved.edition!))
      .toEqual({ ok: true, data: detail.answer });
    expect(failures).toEqual([]);
  });

  test(`${persona}: a recorded save, replay and compare-and-set keep the exact edition`, async () => {
    for (const label of ['primary-put-me-edition-preferences-1', 'primary-put-me-edition-preferences-3', 'primary-put-me-edition-preferences-4'] as const) {
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
