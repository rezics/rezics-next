import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import games from '../../../../tests/qa/fixtures/outcomes/games/work-hub-and-edition-choice.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { mainTrackingApi } from '../tracking/api.ts';
import type { EditionChoice } from '../tracking/types.ts';
import { workExperience } from '../entity-page/experience.ts';
import { readWorkParts, readWorkRealizations } from './anime-hub-recorded-page.ts';
import { booksEditionReads, readBooksEditionStatus } from './books-edition-page.read.ts';
import { gamesAnswerLabel, readGamesHub, readSuppliedStart, recordedGamesSelections } from './games-hub-recorded-page.ts';
import { textHref } from './route.ts';

// Production availability asks for releases and realizations with limit=20, and parts with limit=1.
// The exact release remains readable at its own address.

const record = games as AnswerRecord;
const signedIn = ['stranger', 'member', 'owner', 'moderator', 'operator'] as const;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].filter(item => item.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded answer: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

function answerLabel(persona: AnswerPersona, labels: readonly string[]) {
  return gamesAnswerLabel(record, persona, labels);
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
  expect((refused.answer as { code: string }).code).toBe('account_assertion_denied');
  expect((missing.answer as { code: string }).code).toBe('work_unavailable');
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

test('every persona reads the recorded release list', async () => {
  for (const persona of ['visitor', ...signedIn] as const) {
    const releases = sample(persona, 'hub-releases');
    const main = transport(persona, [{ label: releases.label, state: 'populated' }]);
    const reads = booksEditionReads({ main, actingSubject: subjectOf(persona) ?? undefined });
    expect<unknown>(await reads.readReleases(workId(persona))).toEqual({ ok: true, data: releases.answer });
    const listed = releases.answer as { items: { id: string; title: { value: string } }[] };
    const detail = sample(persona, 'release-details').answer as { id: string; title: { value: string } };
    expect(listed.items.filter(item => item.id === detail.id)).toHaveLength(1);
    expect(listed.items.find(item => item.id === detail.id)?.title.value).toBe(detail.title.value);
  }
});

test('the chooser reads each persona’s recorded realizations and the availability parts probe', async () => {
  for (const persona of ['visitor', ...signedIn] as const) {
    const realizations = sample(persona, answerLabel(persona, ['realizations-empty', 'hub-realizations-empty']));
    const parts = sample(persona, 'hub-partless-parts');
    const actingSubject = subjectOf(persona) ?? undefined;
    const main = transport(persona, [
      { label: realizations.label, state: 'populated' }, { label: parts.label, state: 'error' },
    ]);
    const id = workId(persona);
    expect<unknown>(await readWorkRealizations(main, actingSubject, id)).toEqual({ ok: true, data: realizations.answer });
    expect((realizations.answer as { items: unknown[] }).items).toHaveLength(0);
    expect<unknown>(await readWorkParts(main, actingSubject, id, { limit: 1 })).toEqual({ ok: false, failure: 'missing', status: parts.status, problem: parts.answer });
    expect((parts.answer as { code: string }).code).toBe('work_unavailable');
  }
});

test('the primary action starts from the recorded continue list and missing contents', async () => {
  for (const persona of ['visitor', ...signedIn] as const) {
    const contents = sample(persona, answerLabel(persona, ['contents-unavailable', 'hub-contents-unavailable']));
    const selections = persona === 'visitor'
      ? [{ label: contents.label, state: 'error' as const }]
      : [{ label: answerLabel(persona, ['continue-reading', 'hub-continue-reading']), state: 'populated' as const },
        { label: contents.label, state: 'error' as const }];
    let calls = 0;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    disposals.push(replay.dispose);
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      return replay.fetcher(input, init);
    }) as typeof fetch;
    const main = browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor', fetcher });
    const actingSubject = subjectOf(persona) ?? undefined;
    const id = workId(persona);
    const header = sample(persona, 'work-header').answer as { id: string; selectedLanguage: string | null };
    expect(await readSuppliedStart({ main, actingSubject }, id, header.id, async () => header.selectedLanguage)).toEqual({
      kind: 'start', href: textHref(id), chapter: null,
    });
    expect(calls).toBe(persona === 'visitor' ? 1 : 2);
  }
});

test('a refused contents read retains its owner failure instead of disclosing a Read destination', async () => {
  const main = browserMainApi('https://recorded.invalid', { anonymous: true,
    fetcher: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ code: 'read_unavailable' }, { status: 503 })) as typeof fetch });
  let textReads = 0;
  expect(await readSuppliedStart({ main }, workId('visitor'), 'https://rezics.com/work/example', async () => {
    textReads += 1;
    return 'en';
  })).toMatchObject({ kind: 'unavailable', ok: false, failure: 'unavailable', status: 503,
    problem: { code: 'read_unavailable' } });
  expect(textReads).toBe(0);
});

test('each signed-in reader’s progress summary is their own recorded answer', async () => {
  for (const persona of signedIn) {
    const progress = sample(persona, answerLabel(persona, ['progress-summary', 'hub-progress-summary']));
    const main = transport(persona, [{ label: progress.label, state: 'populated' }]);
    const reads = booksEditionReads({ main, actingSubject: subjectOf(persona) ?? undefined });
    expect<unknown>(await reads.readProgressSummary(workId(persona), 'en')).toEqual({ ok: true, data: progress.answer });
    expect((progress.answer as { status: string; scope: string }).status).toBe('not-started');
    expect((progress.answer as { scope: string }).scope).toBe('work');
  }
});

test('every persona’s projection is a game, so availability is the non-book list and chooser', async () => {
  for (const persona of ['visitor', ...signedIn] as const) {
    const projection = sample(persona, 'hub-projection');
    const releases = sample(persona, 'hub-releases');
    const registry = (projection.answer as { registry?: { presentation?: string; primaryAction?: string } }).registry;
    if (!registry?.presentation || !registry.primaryAction) throw new Error(`The recorded projection names no page for ${persona}`);
    const main = transport(persona, recordedGamesSelections(record, persona, 'populated'));
    const hub = await readGamesHub({ main, actingSubject: subjectOf(persona) ?? undefined }, workId(persona), 'en');
    if (!hub.header.ok || hub.book !== false) throw new Error(`The recorded game was read as a book for ${persona}`);
    if (!hub.projection.ok) throw new Error(`The recorded game projection did not load for ${persona}`);
    expect<unknown>(hub.projection.data).toEqual(projection.answer);
    expect(hub.experience.presentation).toBe(registry.presentation);
    expect(hub.experience.primaryAction).toBe(registry.primaryAction);
    expect(workExperience(hub.projection.data, hub.header.data.types).kind).not.toBe('book');
    expect<unknown>(hub.releases).toEqual({ ok: true, data: releases.answer });
    expect(hub.shown).toBe(true);
    expect(hub.action).toEqual({ kind: 'read', start: { kind: 'start', href: textHref(workId(persona)), chapter: null } });
    if (persona === 'visitor') {
      expect(hub.preference).toEqual({ ok: false, failure: 'sign-in' });
      expect(hub.progress).toEqual({ ok: false, failure: 'sign-in' });
    } else {
      expect(hub.preference).toEqual({ ok: true, data: null });
      const progress = sample(persona, answerLabel(persona, ['progress-summary', 'hub-progress-summary']));
      expect<unknown>(hub.progress).toEqual({ ok: true, data: progress.answer });
    }
  }
});

test('the owner reads the recorded unpublished draft', async () => {
  const draft = sample('owner', 'unpublished-work');
  const url = new URL(draft.path, 'https://recorded.invalid');
  const main = transport('owner', [{ label: draft.label, state: 'populated' }]);
  const reads = booksEditionReads({ main, actingSubject: url.searchParams.get('actingSubject')! });
  expect<unknown>(await reads.readWorkHeader(url.pathname.split('/').at(-1)!)).toEqual({ ok: true, data: draft.answer });
  expect((draft.answer as { id: string }).id).not.toBe((sample('owner', 'work-header').answer as { id: string }).id);
});
