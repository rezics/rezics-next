import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import hub from '../../../../../scripts/qa/cases/outcomes/books/work-hub-and-edition-choice.ts';
import ambiguous from '../../../../../scripts/qa/cases/outcomes/books/choose-among-ambiguous-editions-of-one-work-ambiguous-editions.ts';
import formats from '../../../../../scripts/qa/cases/outcomes/books/choose-among-mixed-formats-mixed-formats.ts';
import catalogue from '../../../../../scripts/qa/cases/outcomes/books/catalogue-browse-and-search-in-its-zone.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

type Work = { work: string; mainVersion: string };
type Release = { id: string; revision: string; platform: string; title: { value: string } };
type Preference = { version: number; edition: { kind: string; resource: string; revision: string } };
type Page<T> = { items: T[]; nextCursor: string | null; matches: { value: number; kind: string } };
setDefaultTimeout(60_000);
let sessions: PersonaSessions;
let book: Work;
let releases: Release[];
const works: Work[] = [];
const phrase = `Bookgarden${randomUUID().replaceAll('-', '')}`;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => person.actingSubject
  ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';

async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
// Setup exceptions stay in beforeAll: a failed fixture is never an expected product failure.
beforeAll(async () => {
  sessions = await personaSessions('public');
  const owner = sessions.owner, actor = owner.actingSubject;
  const root = `/v1/realms/${short(sessions.realm)}`;
  const roleId = randomUUID();
  for (const change of [
    { kind: 'role', roleId, name: 'Catalogue editors', permissions: ['publication.adopt'] },
    { kind: 'assignment', roleId, member: actor, assigned: true,
      validUntil: new Date(Date.now() + 3_600_000).toISOString() },
  ]) {
    const roles = await answer<{ generation: string }>(owner.main('GET', `${root}/roles?${acting(owner)}`));
    const command = { actingSubject: actor, expectedGeneration: roles.generation,
      reason: 'Publish the original Book fixture catalogue', change };
    const preview = await answer<{ digest: string }>(owner.main('POST', `${root}/role-impact`, command));
    await answer(owner.main('POST', `${root}/role-changes`, { ...command, impactDigest: preview.digest }), 201);
  }
  for (let index = 0; index < 21; index++) {
    const work = await answer<Work>(owner.main('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: `${phrase} ${index}`, language: 'en',
      semanticTypes: ['https://schema.org/Book'], authoring: 'own-work', actingSubject: actor,
    }), 201);
    const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: work.work, language: 'en',
      body: `An original fixture story: gardener ${index} plants a seed and watches it grow.`, actingSubject: actor,
    }), 201);
    const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor,
    }), 201);
    const selection = { work: work.work, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null, actingSubject: actor };
    await answer(owner.main('POST', '/v1/publication-selections', { ...selection,
      profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
      selectionBasis: 'main-maintainer' }), 201);
    await answer(owner.main('POST', '/v1/publication-selections', { ...selection,
      profile: 'realm-local-selection-v1', context: { kind: 'realm-local', id: sessions.realm },
      mainVersion: work.mainVersion, selectionBasis: 'realm-manager-review' }), 201);
    works.push(work);
  }
  book = works[0]!;
  const header = await answer<{ mainVersionRevision: string }>(owner.main('GET', `/v1/works/${short(book.work)}?${acting(owner)}`));
  const realization = `https://rezics.com/id/${randomUUID()}`;
  const original = await answer<{ revision: string }>(owner.main('PUT', `/v1/works/${short(book.work)}/realizations/${short(realization)}`, {
    profile: 'realization-v1', id: realization, expectedHead: null, actingSubject: actor,
    language: 'en', kind: 'original', translators: [], publishers: [],
    source: { kind: 'main-version', work: book.work, mainVersion: book.mainVersion, revision: header.mainVersionRevision },
    status: 'official', verification: 'verified', evidence: book.work,
  }));
  releases = [];
  for (const platform of ['paperback', 'ebook', 'audiobook']) {
    const id = `https://rezics.com/id/${randomUUID()}`;
    const result = await answer<{ revision: string }>(owner.main('PUT', `/v1/works/${short(book.work)}/releases/${short(id)}`, {
      profile: 'release-v2', id, expectedHead: null, actingSubject: actor, kind: 'formal', status: 'official',
      identifiers: [], territory: null, titleLanguage: 'en', tracklistLanguage: null,
      title: { value: phrase, language: 'en' }, editionStatement: platform, publisher: 'Original fixture owner',
      publicationYear: 2026, isbn13: null, originalUrl: null, fixedRelease: null, evidence: null, platform,
      coverage: [{ realization, revision: original.revision, completeness: 'complete' }],
    }));
    releases.push({ id, revision: result.revision, platform, title: { value: phrase } });
  }
}, 180_000);
afterAll(async () => { await sessions?.close(); });

// All operator calls below are ordinary member/public routes. These rows have no platform operation.
async function editions(name: PersonaName, mode: 'hub' | 'ambiguous' | 'formats') {
  const person = sessions[name], workPath = `/v1/works/${short(book.work)}`;
  const header = await answer<{ id: string }>(person.main('GET', `${workPath}?${acting(person)}`));
  expect(header.id).toBe(book.work);
  const credits = await answer<{ items: { agent: string | null }[] }>(person.main('GET', `${workPath}/credits?${acting(person)}`));
  expect(credits.items.some(credit => credit.agent === sessions.owner.actingSubject)).toBe(true);
  const page = await answer<Page<Release>>(person.main('GET', `${workPath}/releases?${acting(person)}&limit=2`));
  expect(page.nextCursor).not.toBeNull();
  const next = await answer<Page<Release>>(person.main('GET', `${workPath}/releases?${acting(person)}&limit=2&cursor=${encodeURIComponent(page.nextCursor!)}`));
  const choices = [...page.items, ...next.items];
  expect(next.nextCursor).toBeNull();
  expect(choices.map(item => item.id).sort()).toEqual(releases.map(item => item.id).sort());
  expect(new Set(choices.map(item => item.title.value)).size).toBe(1);
  expect(choices.map(item => item.platform).sort()).toEqual(['audiobook', 'ebook', 'paperback']);
  const path = `/v1/me/edition-preferences/${short(book.work)}`;
  const body = { actingSubject: person.actingSubject ?? sessions.member.actingSubject,
    expectedVersion: 0, language: 'en', edition: { kind: 'release', resource: releases[0]!.id, revision: releases[0]!.revision } };
  if (name === 'visitor') {
    await answer(person.main('GET', `${path}?actingSubject=${encodeURIComponent(body.actingSubject!)}`), 401);
    await answer(person.main('PUT', path, body), 401);
    return;
  }
  const ownPath = `${path}?${acting(person)}`;
  let current = await answer<Preference | null>(person.main('GET', ownPath));
  for (const release of mode === 'hub' ? releases.slice(0, 1) : releases) {
    const key = randomUUID();
    const command = { ...body, expectedVersion: current?.version ?? 0,
      edition: { kind: 'release', resource: release.id, revision: release.revision } };
    current = await answer<Preference>(person.main('PUT', path, command, key));
    expect(current.edition).toEqual(command.edition);
    expect(await answer(person.main('GET', ownPath))).toMatchObject(current);
    expect(await answer(person.main('PUT', path, command, key))).toMatchObject({ ...current, replayed: true });
    await answer(person.main('PUT', path, command), 409);
  }
  if (mode === 'hub') {
    const summary = await answer<{ preference: Preference }>(person.main('GET', `/v1/me/progress-summaries/${short(book.work)}?${acting(person)}`));
    expect(summary.preference).toMatchObject(current!);
  }
  const foreign = name === 'member' ? sessions.stranger : sessions.member;
  const foreignPath = `${path}?${acting(foreign)}`;
  const before = await answer<Preference | null>(foreign.main('GET', foreignPath));
  await answer(person.main('GET', foreignPath), 403);
  await answer(person.main('PUT', path, { ...body, actingSubject: foreign.actingSubject,
    expectedVersion: before?.version ?? 0 }), 403);
  expect(await answer(foreign.main('GET', foreignPath))).toEqual(before);
}

async function browse(name: PersonaName) {
  const person = sessions[name];
  const root = `/v1/realms/${short(sessions.realm)}/modules`;
  for (const sort of ['newest', 'updated', 'relevance']) {
    for (const q of ['', phrase]) {
      const params = new URLSearchParams({ sort, limit: '10', type: 'https://schema.org/Book', ...(q ? { q } : {}) });
      const seen: string[] = [];
      let page: Page<{ id: string }>;
      do {
        page = await answer<Page<{ id: string }>>(person.main('GET', `${root}/browse?${params}`));
        seen.push(...page.items.map(item => item.id));
        if (page.nextCursor) params.set('cursor', page.nextCursor);
      } while (page.nextCursor);
      expect(seen.length).toBe(21);
      expect(new Set(seen).size).toBe(21);
      expect(seen.sort()).toEqual(works.map(work => work.work).sort());
      expect(page.matches).toEqual({ value: 21, kind: 'exact' });
    }
  }
  const first = await answer<Page<{ id: string }>>(person.main('GET', `${root}/new-adoptions?limit=20`));
  expect(first.nextCursor).not.toBeNull();
  const second = await answer<Page<{ id: string }>>(person.main('GET', `${root}/new-adoptions?limit=20&cursor=${encodeURIComponent(first.nextCursor!)}`));
  expect([...first.items, ...second.items].map(item => item.id).sort()).toEqual(works.map(work => work.work).sort());
  expect(second.nextCursor).toBeNull();
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
outcomeTest(catalogue, 'visitor', () => browse('visitor'));
outcomeTest(catalogue, 'stranger', () => browse('stranger'));
outcomeTest(catalogue, 'member', () => browse('member'));
outcomeTest(catalogue, 'owner', () => browse('owner'));
outcomeTest(catalogue, 'moderator', () => browse('moderator'));
outcomeTest(catalogue, 'operator', () => browse('operator'));
