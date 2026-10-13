import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { grantLaunchRecipeAuthority } from '../../../../../scripts/load/launch-corpus.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { settledWrite } from '../../../support/settled-write.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(120_000);
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
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});
import row from '../../../../../scripts/qa/cases/outcomes/anime/continue-progress-across-devices-two-device-progress.ts';
const recording = new OutcomeRecorder(row);
let preparing = true;
const sample = async (name: PersonaName, person: PersonaSession, label: string, ...args: Parameters<PersonaSession['main']>) => {
  const response = await recording.session(name, person)(label, ...args);
  if (response.status >= 500) await answer(Promise.resolve(response));
  return response;
};

type Progress = { completed: boolean; version: number; position: string | null; replayed?: boolean };
let show: Work, structure: string;
const occurrences: string[] = [], targets: string[] = [];
beforeAll(async () => {
  const started = Date.now();
  try {
  sessions = await personaSessions();
  await recording.prepare();
  for (const name of ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const person = sessions[name], main = person.main;
    person.main = async (method, path, body, key, options) => {
      key ??= method === 'GET' ? undefined : randomUUID();
      const response = await (preparing && method !== 'GET'
        ? settledWrite(main, method, path, body, key) : main(method, path, body, key, options));
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
    preparing = false;
    preparation.durationMs = Date.now() - started;
    await Bun.write(`.temp/anime-continue-progress-across-devices-two-device-progress-preparation-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(preparation, null, 2));
  }
}, 180_000);
const progressPath = (index = 0) => `/v1/compositions/${short(structure)}/occurrences/${short(occurrences[index]!)}/progress`;
const read = (name: PersonaName, person: PersonaSession, label: string, index = 0) =>
  answer<Progress>(sample(name, person, label, 'GET', `${progressPath(index)}?${acting(person)}`));
const write = (name: PersonaName, person: PersonaSession, label: string, completed: boolean, expectedVersion: number, key = randomUUID(), index = 0) =>
  sample(name, person, label, 'PUT', progressPath(index), { actingSubject: person.actingSubject, completed, expectedVersion, position: null }, key);
async function publicOpening(name: PersonaName, person: PersonaSession) {
  const query = person.actingSubject ? `&${acting(person)}` : '';
  const opening = await answer<{ items: { occurrence: string; target: string }[]; nextCursor: string | null }>(
    sample(name, person, 'public-episode-opening', 'GET', `/v1/reading-positions/${short(show.work)}?position=start&limit=1${query}`));
  expect(opening.items).toMatchObject([{ occurrence: occurrences[0], target: targets[0] }]);
  expect(opening.nextCursor).not.toBeNull();
}
async function isolated(name: PersonaName, person: PersonaSession, affected: PersonaSession) {
  const path = `/v1/works/${short(show.work)}`;
  expect(await answer(sample(name, person, 'foreign-reader-state-refused', 'GET', `${path}/reader-state?${acting(affected)}`), 403))
    .toMatchObject({ code: 'reader_library_denied' });
  await answer(sample(name, person, 'foreign-reader-status-refused', 'PUT', `${path}/reader-status`, {
    actingSubject: affected.actingSubject, expectedVersion: 0, status: 'reading',
  }), 403);
  expect(await read(name, person, 'own-unwatched-episode', 2)).toMatchObject({ completed: false, version: 0, position: null });
  const foreignPath = `${progressPath(2)}?${acting(affected)}`;
  const foreign = await sample(name, person, 'foreign-episode-progress-refused', 'GET', foreignPath);
  const before = await answer(sample(name, affected, 'affected-progress-before', 'GET', `${progressPath(2)}?${acting(affected)}`));
  const body = { actingSubject: affected.actingSubject, completed: true, expectedVersion: 0, position: null };
  const response = await sample(name, person, 'foreign-episode-write-refused', 'PUT', progressPath(2), body);
    const persona = (['stranger', 'member', 'owner', 'moderator', 'operator'] as const)
      .find(name => sessions[name] === person)!;
    await Bun.write(`.temp/anime-continue-progress-across-devices-two-device-progress-${Bun.env.REZICS_QA_RUN_ID}-${persona}.json`,
      JSON.stringify({ persona, get: { request: { method: 'GET', path: foreignPath },
        status: foreign.status, answer: await foreign.clone().text() },
        put: { request: requests.get(response),
          status: response.status, answer: await response.clone().text() } }, null, 2));
  const after = await answer(sample(name, affected, 'affected-progress-after', 'GET', `${progressPath(2)}?${acting(affected)}`));
  // The caller's Account progress must not project a last-read timestamp onto an uncontrolled Person.
  expect(after).toEqual(before);
  await answer(Promise.resolve(response), 403);
  // Reading progress requires control of the presented Person, even for an empty Account row.
  expect(await answer(Promise.resolve(foreign), 403)).toMatchObject({ code: 'authority_denied' });
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

// /en/w/{work}: server reads from WorkFrameView, WorkOverview and their section readers.
// The episode panel's initial browser reads also supply the two-device story's render answers.
async function workPageReads(name: PersonaName, person: PersonaSession) {
  const id = short(show.work);
  const viewer = (path: string) => person.actingSubject
    ? `${path}${path.includes('?') ? '&' : '?'}${acting(person)}` : path;
  const get = async <T,>(label: string, path: string): Promise<T> => {
    const response = await sample(name, person, label, 'GET', viewer(path));
    return await response.json() as T;
  };
  await sample(name, person, 'platform-access', 'GET', '/v1/me/platform-access');
  await Promise.all([
    sample(name, sessions.visitor, 'metadata-public-preview', 'GET', `/v1/public-previews/${id}`),
    sample(name, sessions.visitor, 'metadata-work-header', 'GET', `/v1/works/${id}`),
  ]);
  if (person.actingSubject) {
    // reader() and the Eden header builder each cache their own session-agent read.
    await sample(name, person, 'session-agent', 'GET', '/v1/me/session-agent');
    await sample(name, person, 'content-language-session-agent', 'GET', '/v1/me/session-agent');
    await get('person-language-preferences', '/v1/me/person-preferences');
  }
  // Resolve the projection before the section fan-out to keep the expensive graph read bounded.
  const page = await get<{ sections?: { id: string; href: string }[] }>('page-projection', `/v1/resources/${id}/page`);
  const [contexts, parts] = await Promise.all([
    get<{ items?: { context: string }[] }>('rating-contexts', `/v1/resources/${id}/rating-contexts?scope=global`),
    get<{ parts?: { work?: string }[] }>('parts-preview', `/v1/resources/${id}/parts?limit=7`),
    get('work-header', `/v1/works/${id}`),
    get('agent-credits', `/v1/works/${id}/agent-credits`),
    get('rating-populations-empty', `/v1/rating-populations?${new URLSearchParams({ limit: '20', target: id })}`),
    get('wholes-preview-empty', `/v1/resources/${id}/wholes?limit=3`),
    get('relations-empty', `/v1/resources/${id}/relations?limit=20`),
    get('realizations-empty', `/v1/works/${id}/realizations?limit=20`),
    get('releases-empty', `/v1/works/${id}/releases?limit=20`),
    get('availability-parts', `/v1/resources/${id}/parts?limit=1`),
    sample(name, person, 'work-credits-template', 'POST', '/v1/query', {
      profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits', revision: 1,
      parameters: { roots: [show.work] },
      presentation: { ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}) },
    }),
    // The server's showcase reader always uses the anonymous client.
    sample(name, sessions.visitor, 'work-showcase', 'POST', '/v1/resources/showcase', {
      profile: 'work-showcase-batch-v1', targets: [show.work],
    }),
  ]);
  await Promise.all(([['statements', 'wiki-shortcut-statements'], ['discussion', 'discussion-empty']] as const).map(async ([section, label]) => {
    const href = page.sections?.find(item => item.id === section)?.href;
    if (href) await get(label, href);
  }));
  const context = contexts.items?.[0]?.context;
  await Promise.all([
    get('ratings', `/v1/resources/${id}/ratings?${new URLSearchParams({ scope: 'global', ...(context ? { context } : {}) })}`),
    get('reader-stats', `/v1/works/${id}/reader-stats${context ? `?${new URLSearchParams({ context })}` : ''}`),
  ]);
  const resources = [...new Set(parts.parts?.flatMap(part => part.work ?? []) ?? [])].sort();
  if (resources.length) await sample(name, person, 'part-names', 'POST', '/v1/resources/summaries', {
    profile: 'resource-summary-batch-v1', resources,
    ...(person.actingSubject ? { actingSubject: person.actingSubject } : {}),
  });
  if (!person.actingSubject) return;
  const [composition] = await Promise.all([
    get<{ next: string | null }>('episode-structure', `/v1/compositions/${short(structure)}?limit=20`),
    get('reader-state', `/v1/works/${id}/reader-state`),
    get('edition-preference-empty', `/v1/me/edition-preferences/${id}`),
    get('progress-summary', `/v1/me/progress-summaries/${id}?language=en`),
    get('episode-structure-discovery', `/v1/resources/${id}/parts?limit=20`),
    get('episode-resume', `/v1/reading-positions/${id}?position=mine&limit=1`),
    get('episode-progress-empty', progressPath()),
    get('correspondence-definition', '/v1/lexicon/definitions/correspondence-equivalent'),
  ]);
  if (composition.next) await get('episode-structure-continuation',
    `/v1/compositions/${short(structure)}?${new URLSearchParams({ limit: '20', after: composition.next })}`);
}
async function journey(name: PersonaName) {
  const person = sessions[name];
  await workPageReads(name, person);
  if (name === 'visitor') {
    await publicOpening(name, person);
    await answer(sample(name, person, 'episode-progress-sign-in-required', 'GET', `${progressPath()}?${acting(sessions.member)}`), 401);
    await answer(sample(name, person, 'episode-write-sign-in-required', 'PUT', progressPath(), {
      actingSubject: sessions.member.actingSubject, completed: true, expectedVersion: 0, position: null }), 401);
    return;
  }
  const device = await secondDevice(person);
  expect(device.accountId).toBe(person.accountId);
  expect(await read(name, device, 'second-device-progress-empty')).toMatchObject({ completed: false, version: 0 });
  const key = randomUUID();
  const saved = await answer<Progress>(write(name, person, 'first-device-watched', true, 0, key));
  expect(saved).toMatchObject({ completed: true, version: 1 });
  expect(await answer(write(name, device, 'second-device-watched-replay', true, 0, key))).toMatchObject({ ...saved, replayed: true });
  expect(await read(name, device, 'second-device-watched')).toMatchObject({ completed: true, version: 1 });
  expect(await answer(sample(name, device, 'second-device-resume', 'GET', `/v1/reading-positions/${short(show.work)}?${acting(device)}&position=mine&limit=1`)))
    .toMatchObject({ resolved: occurrences[0], scope: 'resume', items: [{ occurrence: occurrences[0], target: targets[0] }] });
  expect(await answer(write(name, device, 'second-device-stale-write', false, 0), 409)).toMatchObject({ code: 'stale_progress' });
  const raced = await Promise.all([write(name, person, 'first-device-race', false, 1), write(name, device, 'second-device-race', true, 1)]);
  expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
  const winner = await answer<Progress>(Promise.resolve(raced.find(response => response.status === 200)!));
  expect(winner.version).toBe(2);
  expect(await answer(Promise.resolve(raced.find(response => response.status === 409)!), 409))
    .toMatchObject({ code: 'stale_progress' });
  for (const reader of [person, device]) {
    expect(await read(name, reader, reader === person ? 'first-device-race-result' : 'second-device-race-result')).toMatchObject({ completed: winner.completed, version: 2 });
  }
  expect(await answer<Progress>(write(name, device, 'second-device-next-version', !winner.completed, 2)))
    .toMatchObject({ completed: !winner.completed, version: 3 });
  expect(await read(name, person, 'first-device-next-version')).toMatchObject({ completed: !winner.completed, version: 3 });
  await isolated(name, person, name === 'owner' ? sessions.member : sessions.owner);
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
outcomeTest(row, 'visitor', () => qualify('visitor'), recording);
outcomeTest(row, 'stranger', () => qualify('stranger'), recording);
outcomeTest(row, 'member', () => qualify('member'), recording);
outcomeTest(row, 'owner', () => qualify('owner'), recording);
outcomeTest(row, 'moderator', () => qualify('moderator'), recording);
outcomeTest(row, 'operator', () => qualify('operator'), recording);

