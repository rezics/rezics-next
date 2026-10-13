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
    await Bun.write(`.temp/anime-continue-progress-across-devices-two-device-progress-failures-${Bun.env.REZICS_QA_RUN_ID}.json`,
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
import row from '../../../../../scripts/qa/cases/outcomes/anime/continue-progress-across-devices-two-device-progress.ts';

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
    await Bun.write(`.temp/anime-continue-progress-across-devices-two-device-progress-preparation-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(preparation, null, 2));
  }
}, 180_000);
const progressPath = (index = 0) => `/v1/compositions/${short(structure)}/occurrences/${short(occurrences[index]!)}/progress`;
const read = (person: PersonaSession, index = 0) => answer<Progress>(person.main('GET', `${progressPath(index)}?${acting(person)}`));
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
  expect(await read(person, 2)).toMatchObject({ completed: false, version: 0, position: null });
  const foreignPath = `${progressPath(2)}?${acting(affected)}`;
  const foreign = await person.main('GET', foreignPath);
  const before = await answer(affected.main('GET', `${progressPath(2)}?${acting(affected)}`));
  const body = { actingSubject: affected.actingSubject, completed: true, expectedVersion: 0, position: null };
  const response = await person.main('PUT', progressPath(2), body);
    const persona = (['stranger', 'member', 'owner', 'moderator', 'operator'] as const)
      .find(name => sessions[name] === person)!;
    await Bun.write(`.temp/anime-continue-progress-across-devices-two-device-progress-${Bun.env.REZICS_QA_RUN_ID}-${persona}.json`,
      JSON.stringify({ persona, get: { request: { method: 'GET', path: foreignPath },
        status: foreign.status, answer: await foreign.clone().text() },
        put: { request: requests.get(response),
          status: response.status, answer: await response.clone().text() } }, null, 2));
  const after = await answer(affected.main('GET', `${progressPath(2)}?${acting(affected)}`));
  // The caller's Account progress must not project a last-read timestamp onto an uncontrolled Person.
  expect(after).toEqual(before);
  await answer(Promise.resolve(response), 403);
  // Retain the old expectation until the live uncontrolled-Person answer is qualified.
  expect(await answer(Promise.resolve(foreign))).toMatchObject({ completed: false, version: 0 });
}

import { readFileSync } from 'node:fs';
import { signIn } from '../../../../../scripts/lib/oauth-client.ts';
import { outcomeResponse } from '../../../support/outcome-test.ts';

async function secondDevice(person: PersonaSession): Promise<PersonaSession> {
  const directory = `.temp/stack/rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`;
  const paths = [...new Bun.Glob('**/public.json').scanSync({ cwd: directory })]
    .filter(path => path.includes('g-1005-auth-'));
  expect(paths).toHaveLength(1);
  const config = JSON.parse(readFileSync(`${directory}/${paths[0]}`, 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string;
  };
  const oauth = await signIn({ account: Bun.env.ACCOUNT_BASE_URL!, clientId: config.clientId,
    redirectUri: config.redirectUris[0]!, scope: config.scope, resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: (input, init) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/authorize') || url.pathname === '/api/account/consent') {
        return person.account(init?.method ?? 'GET', url.pathname + url.search,
          init?.body ? JSON.parse(String(init.body)) : undefined);
      }
      return fetch(input, init);
    },
  }, '');
  const sessionKey = randomUUID();
  return { actingSubject: person.actingSubject, accountId: person.accountId, account: person.account,
    main: async (method, path, body, key) => {
      const headers = new Headers({ authorization: `Bearer ${await oauth.current()}`, 'x-session-key': sessionKey });
      if (body !== undefined) headers.set('content-type', 'application/json');
      if (method !== 'GET') headers.set('idempotency-key', key ?? randomUUID());
      const request = (signal: AbortSignal) => fetch(`http://127.0.0.1:${Bun.env.MAIN_PORT}${path}`,
        { method, headers, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const response = await (method === 'GET' ? outcomeResponse(request) : request(AbortSignal.timeout(30_000)));
      requests.set(response, { method, path, body, key: headers.get('idempotency-key') ?? undefined });
      return response;
    } };
}
async function journey(name: PersonaName) {
  const person = sessions[name];
  if (name === 'visitor') {
    await publicOpening(person);
    await answer(person.main('GET', `${progressPath()}?${acting(sessions.member)}`), 401);
    await answer(person.main('PUT', progressPath(), {
      actingSubject: sessions.member.actingSubject, completed: true, expectedVersion: 0, position: null }), 401);
    return;
  }
  const device = await secondDevice(person);
  expect(device.accountId).toBe(person.accountId);
  expect(await read(device)).toMatchObject({ completed: false, version: 0 });
  const key = randomUUID();
  const saved = await answer<Progress>(write(person, true, 0, key));
  expect(saved).toMatchObject({ completed: true, version: 1 });
  expect(await answer(write(device, true, 0, key))).toMatchObject({ ...saved, replayed: true });
  expect(await read(device)).toMatchObject({ completed: true, version: 1 });
  expect(await answer(device.main('GET', `/v1/reading-positions/${short(show.work)}?${acting(device)}&position=mine&limit=1`)))
    .toMatchObject({ resolved: occurrences[0], scope: 'resume', items: [{ occurrence: occurrences[0], target: targets[0] }] });
  expect(await answer(write(device, false, 0), 409)).toMatchObject({ code: 'stale_progress' });
  const raced = await Promise.all([write(person, false, 1), write(device, true, 1)]);
  expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = await answer<Progress>(Promise.resolve(raced.find(response => response.status === 200)!));
  expect(winner.version).toBe(2);
  expect(await answer(Promise.resolve(raced.find(response => response.status === 409)!), 409))
    .toMatchObject({ code: 'stale_progress' });
  for (const reader of [person, device]) {
    expect(await read(reader)).toMatchObject({ completed: winner.completed, version: 2 });
  }
  expect(await answer<Progress>(write(device, !winner.completed, 2)))
    .toMatchObject({ completed: !winner.completed, version: 3 });
  expect(await read(person)).toMatchObject({ completed: !winner.completed, version: 3 });
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
    await Bun.write(`.temp/anime-continue-progress-across-devices-two-device-progress-qualification-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify({ preparation, qualification, failures }, null, 2));
  }
}
outcomeTest(row, 'visitor', () => qualify('visitor'));
outcomeTest(row, 'stranger', () => qualify('stranger'));
outcomeTest(row, 'member', () => qualify('member'));
outcomeTest(row, 'owner', () => qualify('owner'));
outcomeTest(row, 'moderator', () => qualify('moderator'));
outcomeTest(row, 'operator', () => qualify('operator'));

