import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import hub from '../../../../../scripts/qa/cases/outcomes/books/work-hub-and-edition-choice.ts';
import ambiguous from '../../../../../scripts/qa/cases/outcomes/books/choose-among-ambiguous-editions-of-one-work-ambiguous-editions.ts';
import formats from '../../../../../scripts/qa/cases/outcomes/books/choose-among-mixed-formats-mixed-formats.ts';
import { outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Release = { id: string; revision: string; platform: string; title: { value: string } };
type Preference = {
  work: string;
  language: string;
  version: number;
  edition: { kind: string; resource: string; revision: string };
};
type Page<T> = { items: T[]; nextCursor: string | null };
setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let book: Work;
const releases: Release[] = [];
const title = `Bookgarden${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) =>
  person.actingSubject ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: () => Promise<Response>, status = 200): Promise<T> {
  const response = await outcomeResponse(request);
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}

async function privateAnswer<T>(request: () => Promise<Response>): Promise<T> {
  const response = await outcomeResponse(request);
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return JSON.parse(raw) as T;
}

// Setup exceptions stay in beforeAll: a failed fixture is never an expected product failure.
beforeAll(async () => {
  sessions = await personaSessions('public');
  const owner = sessions.owner;
  const actor = owner.actingSubject;
  book = await answer<Work>(
    () => owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject: actor,
    }),
    201,
  );
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    () => owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: book.work, language: 'en',
      body: 'An original fixture story: a gardener plants a seed and watches it grow.',
      actingSubject: actor,
    }),
    201,
  );
  const publication = await answer<{ publicationDecision: string }>(
    () => owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }),
    201,
  );
  await answer(
    () => owner.main('POST', '/v1/publication-selections', {
      profile: 'main-default-selection-v1', work: book.work, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      context: { kind: 'main-version-default', id: book.mainVersion },
      selectionBasis: 'main-maintainer', actingSubject: actor,
    }),
    201,
  );
  const workPath = `/v1/works/${short(book.work)}`;
  const header = await answer<{ mainVersionRevision: string }>(
    () => owner.main('GET', `${workPath}?${acting(owner)}`),
  );
  const realization = `https://rezics.com/id/${randomUUID()}`;
  const original = await answer<{ revision: string }>(
    () => owner.main('PUT', `${workPath}/realizations/${short(realization)}`, {
      profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: actor,
      language: 'en', kind: 'original', translators: [], publishers: [],
      source: {
        kind: 'main-version', work: book.work, mainVersion: book.mainVersion,
        revision: header.mainVersionRevision,
      },
      status: 'official', verification: 'verified', evidence: book.work,
    }),
  );
  for (const platform of ['paperback', 'ebook', 'audiobook']) {
    const id = `https://rezics.com/id/${randomUUID()}`;
    const result = await answer<{ revision: string }>(
      () => owner.main('PUT', `${workPath}/releases/${short(id)}`, {
        profile: 'release-v2', id, expectedHead: null, actingSubject: actor,
        kind: 'formal', status: 'official', identifiers: [], territory: null,
        titleLanguage: 'en', tracklistLanguage: null, title: { value: title, language: 'en' },
        editionStatement: platform, publisher: 'Original fixture owner', publicationYear: 2026,
        isbn13: null, originalUrl: null, fixedRelease: null, evidence: null, platform,
        coverage: [{ realization, revision: original.revision, completeness: 'complete' }],
      }),
    );
    releases.push({ id, revision: result.revision, platform, title: { value: title } });
  }
}, 180_000);
afterAll(async () => {
  await sessions?.close();
});

// Operator calls use ordinary reader/public routes, with separate own-Person control.
async function editions(name: PersonaName, mode: 'hub' | 'ambiguous' | 'formats') {
  const person = sessions[name];
  const workPath = `/v1/works/${short(book.work)}`;
  const header = await answer<{ id: string }>(
    () => person.main('GET', `${workPath}?${acting(person)}`),
  );
  expect(header.id).toBe(book.work);
  const credits = await answer<{ items: { agent: string | null; role: string }[] }>(
    () => person.main('GET', `${workPath}/credits?${acting(person)}`),
  );
  expect(credits.items.some(credit =>
    credit.agent === sessions.owner.actingSubject && credit.role === 'author')).toBe(true);
  const page = await answer<Page<Release>>(
    () => person.main('GET', `${workPath}/releases?${acting(person)}&limit=2`),
  );
  expect(page.nextCursor).not.toBeNull();
  const next = await answer<Page<Release>>(
    () => person.main('GET', `${workPath}/releases?${acting(person)}&limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`),
  );
  const choices = [...page.items, ...next.items];
  expect(next.nextCursor).toBeNull();
  expect(choices.map(item => item.id).sort()).toEqual(releases.map(item => item.id).sort());
  expect(new Set(choices.map(item => item.title.value)).size).toBe(1);
  expect(choices.map(item => item.platform).sort()).toEqual(['audiobook', 'ebook', 'paperback']);
  for (const choice of choices) {
    const detail = await answer<Release>(
      () => person.main('GET', `${workPath}/releases/${short(choice.id)}?${acting(person)}`),
    );
    expect(detail).toMatchObject(releases.find(release => release.id === choice.id)!);
  }

  const path = `/v1/me/edition-preferences/${short(book.work)}`;
  const body = {
    actingSubject: person.actingSubject ?? sessions.member.actingSubject,
    expectedVersion: 0, language: 'en',
    edition: { kind: 'release', resource: releases[0]!.id, revision: releases[0]!.revision },
  };
  if (name === 'visitor') {
    await answer(() => person.main('GET', `${path}?actingSubject=${encodeURIComponent(body.actingSubject!)}`), 401);
    await answer(() => person.main('PUT', path, body), 401);
    if (mode === 'hub') {
      await answer(() => person.main('GET', `/v1/me/progress-summaries/${short(book.work)}?actingSubject=${encodeURIComponent(body.actingSubject!)}`), 401);
    }
    return;
  }
  const foreign = name === 'member' ? sessions.stranger : sessions.member;
  const foreignPath = `${path}?${acting(foreign)}`;
  const before = await privateAnswer<Preference | null>(() => foreign.main('GET', foreignPath));
  const ownPath = `${path}?${acting(person)}`;
  let current = await privateAnswer<Preference | null>(() => person.main('GET', ownPath));
  for (const release of mode === 'hub' ? releases.slice(0, 1) : releases) {
    const key = randomUUID();
    const command = {
      ...body, expectedVersion: current?.version ?? 0,
      edition: { kind: 'release', resource: release.id, revision: release.revision },
    };
    const saved = await privateAnswer<Preference & { replayed: boolean }>(
      () => person.main('PUT', path, command, key),
    );
    expect(saved).toMatchObject({
      work: book.work, language: 'en', edition: command.edition,
      version: command.expectedVersion + 1, replayed: false,
    });
    current = await privateAnswer<Preference>(() => person.main('GET', ownPath));
    expect(current).toEqual({
      work: saved.work, language: saved.language, edition: saved.edition, version: saved.version,
    });
    expect(await privateAnswer(() => person.main('PUT', path, command, key))).toEqual({
      ...current, replayed: true,
    });
    const stale = await answer<{ code: string; current: Preference }>(
      () => person.main('PUT', path, command), 409,
    );
    expect(stale.code).toBe('stale_edition_preference');
    expect(stale.current).toEqual(current);
    expect(await privateAnswer(() => foreign.main('GET', foreignPath))).toEqual(before);
  }
  if (mode === 'hub') {
    const summary = await privateAnswer<{ preference: Preference }>(
      () => person.main('GET', `/v1/me/progress-summaries/${short(book.work)}?${acting(person)}`),
    );
    expect(summary.preference).toEqual(current!);
    expect(await answer<{ code: string }>(
      () => person.main('GET', `/v1/me/progress-summaries/${short(book.work)}?${acting(foreign)}`), 403,
    )).toMatchObject({ code: 'progress_denied' });
  }
  for (const denied of [
    () => person.main('GET', foreignPath),
    () => person.main('PUT', path, {
      ...body, actingSubject: foreign.actingSubject, expectedVersion: before?.version ?? 0,
    }),
  ]) {
    expect(await answer<{ code: string }>(denied, 403)).toMatchObject({ code: 'progress_denied' });
  }
  expect(await privateAnswer(() => foreign.main('GET', foreignPath))).toEqual(before);
  expect(await privateAnswer(() => person.main('GET', ownPath))).toEqual(current);
}

outcomeTest(hub, 'visitor', () => editions('visitor', 'hub'));
outcomeTest(hub, 'stranger', () => editions('stranger', 'hub'));
outcomeTest(hub, 'member', () => editions('member', 'hub'));
outcomeTest(hub, 'owner', () => editions('owner', 'hub'));
outcomeTest(hub, 'moderator', () => editions('moderator', 'hub'));
outcomeTest(hub, 'operator', () => editions('operator', 'hub'));
outcomeTest(ambiguous, 'visitor', () => editions('visitor', 'ambiguous'));
outcomeTest(ambiguous, 'stranger', () => editions('stranger', 'ambiguous'));
outcomeTest(ambiguous, 'member', () => editions('member', 'ambiguous'));
outcomeTest(ambiguous, 'owner', () => editions('owner', 'ambiguous'));
outcomeTest(ambiguous, 'moderator', () => editions('moderator', 'ambiguous'));
outcomeTest(ambiguous, 'operator', () => editions('operator', 'ambiguous'));
outcomeTest(formats, 'visitor', () => editions('visitor', 'formats'));
outcomeTest(formats, 'stranger', () => editions('stranger', 'formats'));
outcomeTest(formats, 'member', () => editions('member', 'formats'));
outcomeTest(formats, 'owner', () => editions('owner', 'formats'));
outcomeTest(formats, 'moderator', () => editions('moderator', 'formats'));
outcomeTest(formats, 'operator', () => editions('operator', 'formats'));
