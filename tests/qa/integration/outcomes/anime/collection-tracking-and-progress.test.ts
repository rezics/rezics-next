import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { grantLaunchRecipeAuthority } from '../../../../../scripts/load/launch-corpus.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(90_000);
let sessions: PersonaSessions;
const requests = new WeakMap<Response, { method: string; path: string; body: unknown; key?: string }>();
const failures: { request: unknown; status: number; answer: string }[] = [];
const preparation = { durationMs: 0 };
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
type Work = { work: string; mainVersion: string };
async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending;
  const raw = await response.text();
  if (response.status !== status) {
    failures.push({ request: requests.get(response), status: response.status, answer: raw });
    await Bun.write(`.temp/anime-collection-tracking-and-progress-failures-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify({ preparation, failures }, null, 2));
  }
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
async function grant(person: PersonaSession, scope: string, action: string) {
  const pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  try {
    const principal = await pool.query<{ id: string }>(
      'SELECT id FROM access.principal WHERE account_subject = $1 AND active', [person.accountId]);
    expect(principal.rows).toHaveLength(1);
    await grantLaunchRecipeAuthority(pool, principal.rows[0]!.id, person.actingSubject!, scope, action);
  } finally { await pool.end(); }
}
async function publish(title: string): Promise<Work> {
  const owner = sessions.owner;
  const work = await answer<Work>(owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en', semanticTypes: ['https://schema.org/TVSeries'],
    authoring: 'own-work', actingSubject: owner.actingSubject,
  }), 201);
  const draft = await answer<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', { profile: 'text-contribution-v1',
      work: work.work, language: 'en', body: `Original fixture animation script by Outcome owner: ${title}.`,
      actingSubject: owner.actingSubject }), 201);
  const publication = await answer<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', { profile: 'text-publication-v1',
      contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public',
      actingSubject: owner.actingSubject }), 201);
  await answer(owner.main('POST', '/v1/publication-selections', {
    profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
    work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
    expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: owner.actingSubject,
  }), 201);
  return work;
}
afterAll(async () => { await sessions?.close(); });
import row from '../../../../../scripts/qa/cases/outcomes/anime/collection-tracking-and-progress.ts';

type Progress = { completed: boolean; version: number; position: string | null; replayed?: boolean };
let show: Work, structure: string;
const occurrences: string[] = [], targets: string[] = [];
beforeAll(async () => {
  const started = Date.now();
  try {
  sessions = await personaSessions();
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[name], main = person.main;
    person.main = async (method, path, body, key, options) => {
      key ??= method === 'GET' ? undefined : randomUUID();
      const response = await main(method, path, body, key, options);
      requests.set(response, { method, path, body, key });
      return response;
    };
  }
  const owner = sessions.owner;
  show = await publish('Original animation: Three lantern episodes');
  await grant(owner, 'semantic:create:root', 'semantic.change');
  for (let index = 1; index <= 3; index++) {
    const episode = await answer<{ component: string }>(owner.main('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actingSubject,
      state: { component: 'resource', types: ['https://schema.org/Episode'], properties: [
        { predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: `Original episode ${index}`, language: 'en' } },
        { predicate: 'https://rezics.com/vocab/semanticWork', value: { kind: 'resource', ref: show.work } },
      ] },
    }), 201);
    targets.push(episode.component);
    await grant(owner, `semantic:read:${episode.component}`, 'semantic.read');
  }
  const composition = await answer<{ structure: string; revision: string }>(
    owner.main('POST', '/v1/compositions', { profile: 'work-composition',
      work: show.work, mainVersion: show.mainVersion, actingSubject: owner.actingSubject }), 201);
  structure = composition.structure;
  const changed = await answer<{ occurrences: string[] }>(
    owner.main('POST', `/v1/compositions/${short(structure)}/changes`, {
      profile: 'work-composition', expectedHead: composition.revision, actingSubject: owner.actingSubject,
      operations: targets.map((target, index) => ({ op: 'insert', role: 'part', parent: structure,
        position: 'last', target, displayLabel: `Episode ${index + 1}`, inclusion: 'required' })),
    }));
  occurrences.push(...changed.occurrences);
  expect(occurrences).toHaveLength(3);
  } finally {
    preparation.durationMs = Date.now() - started;
    await Bun.write(`.temp/anime-collection-tracking-and-progress-preparation-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(preparation, null, 2));
  }
}, 180_000);
const progressPath = (index = 0) => `/v1/compositions/${short(structure)}/occurrences/${short(occurrences[index]!)}/progress`;
const write = (person: PersonaSession, completed: boolean, expectedVersion: number, key = randomUUID(), index = 0) =>
  person.main('PUT', progressPath(index), { actingSubject: person.actingSubject, completed, expectedVersion, position: null }, key);
async function publicOpening(person: PersonaSession) {
  const query = person.actingSubject ? `&${acting(person)}` : '';
  const opening = await answer<{ items: { occurrence: string; target: string }[]; nextCursor: string | null }>(
    person.main('GET', `/v1/reading-positions/${short(show.work)}?position=start&limit=1${query}`));
  expect(opening.items).toMatchObject([{ occurrence: occurrences[0], target: targets[0] }]);
  expect(opening.nextCursor).not.toBeNull();
}
async function isolated(person: PersonaSession, affected: PersonaSession) {
  const path = `/v1/works/${short(show.work)}`;
  expect(await answer(person.main('GET', `${path}/reader-state?${acting(affected)}`), 403))
    .toMatchObject({ code: 'reader_library_denied' });
  await answer(person.main('PUT', `${path}/reader-status`, {
    actingSubject: affected.actingSubject, expectedVersion: 0, status: 'reading',
  }), 403);
  expect(await answer(person.main('GET', `${progressPath(2)}?${acting(person)}`)))
    .toMatchObject({ completed: false, version: 0, position: null });
  const foreignPath = `${progressPath(2)}?${acting(affected)}`;
  const foreign = await person.main('GET', foreignPath);
  const before = await answer(affected.main('GET', `${progressPath(2)}?${acting(affected)}`));
  const body = { actingSubject: affected.actingSubject, completed: true, expectedVersion: 0, position: null };
  const response = await person.main('PUT', progressPath(2), body);
    const persona = (['stranger', 'member', 'owner', 'moderator', 'operator'] as const)
      .find(name => sessions[name] === person)!;
    await Bun.write(`.temp/anime-collection-tracking-and-progress-${Bun.env.REZICS_QA_RUN_ID}-${persona}.json`,
      JSON.stringify({ persona, get: { request: { method: 'GET', path: foreignPath },
        status: foreign.status, answer: await foreign.clone().text() },
        put: { request: requests.get(response),
          status: response.status, answer: await response.clone().text() } }, null, 2));
  const after = await answer(affected.main('GET', `${progressPath(2)}?${acting(affected)}`));
  // The caller's Account progress must not project a last-read timestamp onto an uncontrolled Person.
  expect(after).toEqual(before);
  await answer(Promise.resolve(response), 403);
  // Reading progress requires control of the presented Person, even for an empty Account row.
  expect(await answer(Promise.resolve(foreign), 403)).toMatchObject({ code: 'authority_denied' });
}

async function journey(name: PersonaName) {
  const person = sessions[name];
  await publicOpening(person);
  const path = `/v1/works/${short(show.work)}`;
  if (name === 'visitor') {
    expect(await answer(person.main('GET', `${path}/reader-state`))).toMatchObject({
      status: { status: null, version: 0 }, progress: null });
    await answer(person.main('PUT', `${path}/reader-status`, {
      actingSubject: sessions.member.actingSubject, expectedVersion: 0, status: 'reading' }), 401);
    await answer(person.main('GET', `${progressPath()}?${acting(sessions.member)}`), 401);
    await answer(person.main('PUT', progressPath(), {
      actingSubject: sessions.member.actingSubject, completed: true, expectedVersion: 0, position: null }), 401);
    await answer(person.main('GET', `/v1/me/shelves?${acting(sessions.member)}`), 401);
    return;
  }
  const statusBody = { actingSubject: person.actingSubject, expectedVersion: 0, status: 'reading' };
  expect(await answer(person.main('PUT', `${path}/reader-status`, statusBody)))
    .toMatchObject({ work: show.work, status: 'reading', version: 1 });
  const shelf = await answer<{ items: { work: string }[]; nextCursor: string | null }>(
    person.main('GET', `/v1/me/shelves/status/reading/works?${acting(person)}&sort=added&order=desc&limit=1`));
  expect(shelf.items).toMatchObject([{ work: show.work, status: 'reading', version: 1 }]);
  expect(shelf.nextCursor).toBeNull();
  expect(await answer<Progress>(write(person, true, 0))).toMatchObject({ completed: true, version: 1 });
  const completed = await answer<{ items: { occurrence: string }[] }>(
    person.main('GET', `/v1/compositions/${short(structure)}/progress?${acting(person)}&limit=1`));
  expect(completed.items.map(item => item.occurrence)).toEqual([occurrences[0]!]);
  expect(await answer(person.main('GET', `/v1/reading-positions/${short(show.work)}?${acting(person)}&position=mine&limit=1`)))
    .toMatchObject({ resolved: occurrences[0], scope: 'resume' });
  await isolated(person, name === 'owner' ? sessions.member : sessions.owner);
}

const qualification: { persona: string; passed: boolean; error?: string }[] = [];
async function qualify(name: PersonaName) {
  try {
    await journey(name);
    qualification.push({ persona: name, passed: true });
  } catch (error) {
    qualification.push({ persona: name, passed: false, error: String(error) });
    throw error;
  } finally {
    await Bun.write(`.temp/anime-collection-tracking-and-progress-qualification-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify({ preparation, qualification, failures }, null, 2));
  }
}
outcomeTest(row, 'visitor', () => qualify('visitor'));
outcomeTest(row, 'stranger', () => qualify('stranger'));
outcomeTest(row, 'member', () => qualify('member'));
outcomeTest(row, 'owner', () => qualify('owner'));
outcomeTest(row, 'moderator', () => qualify('moderator'));
outcomeTest(row, 'operator', () => qualify('operator'));

