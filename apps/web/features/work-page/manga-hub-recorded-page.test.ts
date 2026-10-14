import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import recorded from '../../../../tests/qa/fixtures/outcomes/manga/work-hub-and-edition-choice.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import { releaseChoiceName } from '../tracking/display.ts';
import { copyOf } from '../tracking/messages.ts';
import type { EditionPreference, Release } from '../tracking/types.ts';
import { booksEditionReads, readBooksEditionStatus } from './books-edition-page.read.ts';

const record = recorded as AnswerRecord;
const signedIn = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const satisfies readonly AnswerPersona[];
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string) {
  const answer = record.personas[persona].find(item => item.label === label);
  if (!answer) throw new Error(`Missing recorded answer: ${record.row}/${persona}/${label}`);
  return answer;
}

function transport(persona: AnswerPersona, selections: RecordedSelection[], failures: string[] = []) {
  const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(replay.dispose);
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await replay.fetcher(input, init); }
    catch (error) { failures.push(String(error)); throw error; }
  }) as typeof fetch;
  return browserMainApi('https://recorded.invalid', { fetcher });
}

function workId(persona: AnswerPersona): string {
  return new URL(sample(persona, 'work').path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
}

function actingSubject(path: string): string {
  const subject = new URL(path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!subject) throw new Error(`Recorded path has no acting subject: ${path}`);
  return subject;
}

/** The preference pins one of the two recorded releases; the other release is someone else's. */
function ownRelease(persona: AnswerPersona, preference: EditionPreference) {
  const resource = preference.edition?.kind === 'release' ? preference.edition.resource : null;
  if (!resource) throw new Error(`${persona} recorded preference does not pin a release`);
  const label = (['release-0', 'release-1'] as const).find(item =>
    (sample(persona, item).answer as { id: string }).id === resource);
  if (!label) throw new Error(`${persona} preference release is not a recorded release`);
  return { label, other: label === 'release-0' ? 'release-1' : 'release-0' as const };
}

test('visitor: the public Work header is the recorded answer', async () => {
  const header = sample('visitor', 'work');
  const failures: string[] = [];
  const main = transport('visitor', [{ label: header.label, state: 'populated' }], failures);
  const reads = booksEditionReads({ main });
  expect<unknown>(await reads.readWorkHeader(workId('visitor'))).toEqual({ ok: true, data: header.answer });
  expect(failures).toEqual([]);
});

test('visitor: the preference and progress refusals keep the recorded problems', async () => {
  for (const [label, read] of [
    ['sign-in-required-0', 'preference'],
    ['sign-in-required-1', 'progress'],
  ] as const) {
    const refused = sample('visitor', label);
    const failures: string[] = [];
    const main = transport('visitor', [{ label, state: 'error' }], failures);
    const reads = booksEditionReads({ main, actingSubject: actingSubject(refused.path) });
    const id = new URL(refused.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    const result = read === 'preference'
      ? await reads.readEditionPreference(id)
      : await reads.readProgressSummary(id);
    expect<unknown>(result).toEqual({
      ok: false, failure: 'sign-in', status: refused.status, problem: refused.answer,
    });
    expect(failures).toEqual([]);
  }
});

for (const persona of signedIn) {
  test(`${persona}: the saved preference names only that person's recorded release`, async () => {
    const header = sample(persona, 'work');
    const preference = sample(persona, 'edition-preference');
    const saved = preference.answer as EditionPreference;
    const release = ownRelease(persona, saved);
    const detail = sample(persona, release.label);
    const progress = sample(persona, 'progress-summary');
    const failures: string[] = [];
    const main = transport(persona, [
      { label: header.label, state: 'populated' },
      { label: preference.label, state: 'populated' },
      { label: release.label, state: 'populated' },
      { label: progress.label, state: 'populated' },
    ], failures);
    const subject = actingSubject(header.path);
    const id = workId(persona);
    const reads = booksEditionReads({ main, actingSubject: subject });
    expect<unknown>(await reads.readWorkHeader(id)).toEqual({ ok: true, data: header.answer });
    const status = await readBooksEditionStatus(reads, id, 'en');
    expect<unknown>(status.preference).toEqual({ ok: true, data: preference.answer });
    expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
    const exact = detail.answer as { title: { value: string }; publisher: string; publicationYear: number };
    expect(status.editionName).toBe(releaseChoiceName(detail.answer as Release, 'en', copyOf('en')));
    expect(status.editionName).toContain(exact.title.value);
    expect(status.editionName).toContain(exact.publisher);
    expect(status.editionName).toContain(String(exact.publicationYear));
    const other = sample(persona, release.other).answer as { title: { value: string } };
    expect(status.editionName).not.toContain(other.title.value);
    const work = (header.answer as { id: string }).id;
    const api = mainTrackingApi(subject, () => main);
    expect<unknown>(await api.preference(work)).toEqual({ ok: true, data: preference.answer });
    expect<unknown>(await api.series(work, saved.language)).toEqual({ ok: true, data: progress.answer });
    expect<unknown>(await api.edition(work, saved.edition!)).toEqual({ ok: true, data: detail.answer });
    expect(failures, failures.join('\n')).toEqual([]);
  });

  test(`${persona}: a recorded null preference is a successful empty read`, async () => {
    const empty = sample(persona, 'edition-preference-empty');
    expect(empty.answer).toBeNull();
    const failures: string[] = [];
    const main = transport(persona, [{ label: empty.label, state: 'empty' }], failures);
    const subject = actingSubject(empty.path);
    const id = new URL(empty.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
    const reads = booksEditionReads({ main, actingSubject: subject });
    expect(await reads.readEditionPreference(id)).toEqual({ ok: true, data: null });
    expect(await mainTrackingApi(subject, () => main).preference((sample(persona, 'work').answer as { id: string }).id))
      .toEqual({ ok: true, data: null });
    expect(failures).toEqual([]);
  });

  test(`${persona}: another person's preference and progress stay refused`, async () => {
    for (const [label, read] of [
      ['other-reader-refused-0', 'preference'],
      ['other-reader-refused-1', 'progress'],
    ] as const) {
      const refused = sample(persona, label);
      const failures: string[] = [];
      const main = transport(persona, [{ label, state: 'error' }], failures);
      const reads = booksEditionReads({ main, actingSubject: actingSubject(refused.path) });
      const id = new URL(refused.path, 'https://recorded.invalid').pathname.split('/').at(-1)!;
      const result = read === 'preference'
        ? await reads.readEditionPreference(id)
        : await reads.readProgressSummary(id);
      expect<unknown>(result).toEqual({
        ok: false, failure: 'sign-in', status: refused.status, problem: refused.answer,
      });
      expect(failures).toEqual([]);
    }
  });
}

test('owner: an empty preference reads the recorded English progress summary', async () => {
  const header = sample('owner', 'work');
  const empty = sample('owner', 'edition-preference-empty');
  const progress = sample('owner', 'progress-summary-empty');
  const failures: string[] = [];
  const main = transport('owner', [
    { label: empty.label, state: 'empty' },
    { label: progress.label, state: 'populated' },
  ], failures);
  const reads = booksEditionReads({ main, actingSubject: actingSubject(header.path) });
  const status = await readBooksEditionStatus(reads, workId('owner'), 'en');
  expect(status.preference).toEqual({ ok: true, data: null });
  expect(status.editionName).toBeNull();
  expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
  expect(failures).toEqual([]);
});

test('visitor: the production release list is the recorded limit of 20', async () => {
  const listed = sample('visitor', 'visit-releases');
  const query = new URL(listed.path, 'https://recorded.invalid').searchParams;
  expect(query.get('limit')).toBe('20');
  expect(query.has('actingSubject')).toBe(false);
  const failures: string[] = [];
  const main = transport('visitor', [{ label: listed.label, state: 'populated' }], failures);
  const reads = booksEditionReads({ main });
  expect<unknown>(await reads.readReleases(workId('visitor'))).toEqual({ ok: true, data: listed.answer });
  const titles = (listed.answer as { items: { title: { value: string }; publisher: string | null }[] }).items;
  expect(new Set(titles.map(item => item.title.value))).toEqual(new Set(['Ink Garden tankōbon', 'Ink Garden omnibus']));
  expect(titles.map(item => item.publisher)).toEqual(['Original fixture owner', 'Original fixture owner']);
  expect(failures).toEqual([]);
});

for (const persona of signedIn) {
  test(`${persona}: the release list and chooser are that person's recorded limit of 20`, async () => {
    const header = sample(persona, 'work');
    const listed = sample(persona, 'visit-releases');
    const realizations = sample(persona, 'visit-realizations');
    const subject = actingSubject(header.path);
    expect(listed.path).toContain('limit=20');
    expect(realizations.path).toContain('limit=20');
    expect(actingSubject(listed.path)).toBe(subject);
    expect(actingSubject(realizations.path)).toBe(subject);
    const failures: string[] = [];
    const main = transport(persona, [
      { label: listed.label, state: 'populated' },
      { label: realizations.label, state: 'populated' },
    ], failures);
    const reads = booksEditionReads({ main, actingSubject: subject });
    expect<unknown>(await reads.readReleases(workId(persona))).toEqual({ ok: true, data: listed.answer });
    const releasePage = listed.answer as { items: { id: string; title: { value: string } }[]; nextCursor: string | null };
    const realizationPage = realizations.answer as { items: { id: string }[]; nextCursor: string | null };
    expect<unknown>(await mainTrackingApi(subject, () => main).editions((header.answer as { id: string }).id)).toEqual({
      ok: true,
      data: {
        realizations: realizationPage.items,
        releases: releasePage.items,
        realizationsCursor: realizationPage.nextCursor,
        releasesCursor: releasePage.nextCursor,
        more: Boolean(realizationPage.nextCursor || releasePage.nextCursor),
      },
    });
    const preference = sample(persona, 'edition-preference').answer as EditionPreference;
    const pinned = releasePage.items.filter(item => item.id === preference.edition?.resource);
    expect(pinned).toHaveLength(1);
    expect(releasePage.items).toHaveLength(2);
    expect(pinned[0]!.title.value).not.toBe(releasePage.items.find(item => item.id !== pinned[0]!.id)!.title.value);
    expect(failures).toEqual([]);
  });

  test(`${persona}: an empty preference reads that person's recorded English progress`, async () => {
    const header = sample(persona, 'work');
    const empty = sample(persona, 'edition-preference-empty');
    const progress = sample(persona, 'visit-status-progress');
    expect(progress.path).toContain('language=en');
    expect(actingSubject(progress.path)).toBe(actingSubject(header.path));
    const failures: string[] = [];
    const main = transport(persona, [
      { label: empty.label, state: 'empty' },
      { label: progress.label, state: 'populated' },
    ], failures);
    const status = await readBooksEditionStatus(
      booksEditionReads({ main, actingSubject: actingSubject(header.path) }), workId(persona), 'en');
    expect(status.preference).toEqual({ ok: true, data: null });
    expect(status.editionName).toBeNull();
    expect<unknown>(status.progress).toEqual({ ok: true, data: progress.answer });
    expect(failures).toEqual([]);
  });
}
