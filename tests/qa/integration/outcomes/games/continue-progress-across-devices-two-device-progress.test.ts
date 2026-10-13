import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from '../../../../../scripts/lib/oauth-client.ts';
import { outcomeResponse } from '../../../support/outcome-test.ts';
import declaration from '../../../../../scripts/qa/cases/outcomes/games/continue-progress-across-devices-two-device-progress.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(90_000);
type Work = { work: string; mainVersion: string };
let sessions: PersonaSessions;
const short = (id: string) => id.slice(-36);
const acting = (person: PersonaSession) => person.actingSubject
  ? `actingSubject=${encodeURIComponent(person.actingSubject)}` : '';
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
// Fixture refusal is a setup failure, never an expected pending outcome.
async function fixture<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  if (response.status !== status) throw new Error(`Fixture HTTP ${response.status}: ${raw}`);
  return JSON.parse(raw) as T;
}
async function createGame(title: string, semanticType = 'VideoGame'): Promise<Work> {
  return fixture<Work>(sessions.owner.main('POST', '/v1/works', {
    profile: 'metadata-only-v1', title, language: 'en',
    description: { value: 'An original game about planting lights in a synthetic garden.', language: 'en' },
    semanticTypes: [`https://schema.org/${semanticType}`],
    authoring: 'own-work', actingSubject: sessions.owner.actingSubject,
  }), 201);
}
async function publish(game: Work) {
  const owner = sessions.owner;
  const draft = await fixture<{ contribution: string; draftRevision: string }>(
    owner.main('POST', '/v1/contributions', {
      profile: 'text-contribution-v1', work: game.work, language: 'en',
      body: 'Original fixture game: plant a light, visit the garden, and find a new route.',
      actingSubject: owner.actingSubject,
    }), 201);
  const published = await fixture<{ publicationDecision: string }>(
    owner.main('POST', '/v1/contribution-publications', {
      profile: 'text-publication-v1', contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: owner.actingSubject,
    }), 201);
  const selection = { work: game.work, contribution: draft.contribution,
    publicationDecision: published.publicationDecision, expectedSelectionHead: null,
    actingSubject: owner.actingSubject };
  await fixture(owner.main('POST', '/v1/publication-selections', {
    ...selection, profile: 'main-default-selection-v1',
    context: { kind: 'main-version-default', id: game.mainVersion },
    selectionBasis: 'main-maintainer',
  }), 201);
  return selection;
}
afterAll(async () => { await sessions?.close(); });

type Standing = { standing: string; version: number; replayed?: boolean };
type Mark = { completed: boolean; position: string | null; version: number; replayed?: boolean };
type ReaderState = { status: { status: string | null; version: number; startedOn: string | null; finishedOn: string | null; changedAt: string | null }; progress: unknown };
let game: Work;
let composed: Work;
let sentinel: Work;
let structure: string;
let required: string;
const wholePath = () => `/v1/works/${short(game.work)}/progress`;
const partPath = (occurrence = required) => `/v1/compositions/${short(structure)}/occurrences/${short(occurrence)}/progress`;
const statePath = (work: Work, person: PersonaSession) => `/v1/works/${short(work.work)}/reader-state?${acting(person)}`;
const summaryPath = (work: Work, person: PersonaSession) => `/v1/me/progress-summaries/${short(work.work)}?${acting(person)}`;
async function setupProgress() {
  sessions = await personaSessions('public');
  game = await createGame('Original partless garden game');
  composed = await createGame('Original garden with main and bonus routes');
  sentinel = await createGame('Original neighbouring garden game');
  const main = await createGame('Original required garden route');
  const bonus = await createGame('Original bonus garden route');
  for (const work of [game, composed, sentinel, main, bonus]) await publish(work);
  const created = await fixture<{ structure: string; revision: string }>(
    sessions.owner.main('POST', '/v1/compositions', { profile: 'work-composition',
      work: composed.work, mainVersion: composed.mainVersion, actingSubject: sessions.owner.actingSubject }), 201);
  structure = created.structure;
  const changed = await fixture<{ occurrences: string[] }>(sessions.owner.main('POST',
    `/v1/compositions/${short(structure)}/changes`, { profile: 'work-composition',
      expectedHead: created.revision, actingSubject: sessions.owner.actingSubject,
      operations: [
        { op: 'insert', parent: structure, position: 'last', role: 'part', target: main.work,
          displayLabel: 'Main garden route', inclusion: 'required' },
        { op: 'insert', parent: structure, position: 'last', role: 'part', target: bonus.work,
          displayLabel: 'Bonus garden route', inclusion: 'extra' },
      ] }));
  [required] = changed.occurrences as [string, string];
}
async function status(person: PersonaSession, work: Work, value: string | null) {
  const current = await answer<ReaderState>(person.main('GET', statePath(work, person)));
  return answer(person.main('PUT', `/v1/works/${short(work.work)}/reader-status`, {
    actingSubject: person.actingSubject, expectedVersion: current.status.version, status: value,
    startedOn: value === 'reading' || value === 'read' ? '2026-10-10' : null,
    finishedOn: value === 'read' ? '2026-10-12' : null,
  }));
}
async function privateBoundary(person: PersonaSession, name: PersonaName) {
  const victim = person === sessions.member ? sessions.stranger : sessions.member;
  await Promise.all([game, composed, sentinel].map(work => status(victim, work, 'reading')));
  // An independently saved neighbour makes an illicit last-read timestamp change observable
  // through the public shelf order, even though reader-state omits lastReadAt.
  const neighbourPath = `/v1/works/${short(sentinel.work)}/progress`;
  const neighbour = await answer<Standing>(victim.main('GET', `${neighbourPath}?${acting(victim)}`));
  await answer(victim.main('PUT', neighbourPath, {
    actingSubject: victim.actingSubject, expectedVersion: neighbour.version, standing: 'started',
  }));
  const shelfPath = `/v1/me/shelves/status/reading/works?${acting(victim)}&sort=last-read&order=desc`;
  const shelf = () => answer<{ items: { work: string }[] }>(victim.main('GET', shelfPath));
  const before = await shelf();
  expect(before.items[0]?.work).toBe(sentinel.work);
  const [beforeWhole, beforePart, beforeState] = await Promise.all([
    answer<Standing>(victim.main('GET', `${wholePath()}?${acting(victim)}`)),
    answer<Mark>(victim.main('GET', `${partPath()}?${acting(victim)}`)),
    answer<ReaderState>(victim.main('GET', statePath(game, victim))),
  ]);
  await Promise.all([statePath(game, victim), summaryPath(game, victim),
    `/v1/me/shelves?${acting(victim)}`, shelfPath].map(path =>
    answer(person.main('GET', path), 403)));
  await answer(person.main('PUT', `/v1/works/${short(game.work)}/reader-status`, {
    actingSubject: victim.actingSubject, expectedVersion: beforeState.status.version, status: null,
  }), 403);
  const [ownWhole, ownPart] = await Promise.all([
    answer<Standing>(person.main('GET', `${wholePath()}?${acting(person)}`)),
    answer<Mark>(person.main('GET', `${partPath()}?${acting(person)}`)),
  ]);
  for (const [path, own] of [[wholePath(), ownWhole], [partPath(), ownPart]] as const) {
    const response = await person.main('GET', `${path}?${acting(victim)}`);
    const body = await response.text();
    expect([200, 403], body).toContain(response.status);
    if (response.status === 200) expect(JSON.parse(body)).toEqual(own);
  }
  const attempts = [
    { path: wholePath(), body: { actingSubject: victim.actingSubject,
      expectedVersion: ownWhole.version, standing: 'completed' } },
    { path: partPath(), body: { actingSubject: victim.actingSubject,
      expectedVersion: ownPart.version, completed: true, position: 'completed' } },
  ];
  const evidence: string[] = [];
  for (const attempt of attempts) {
    const key = randomUUID();
    for (let replay = 0; replay < 2; replay++) {
      const response = await person.main('PUT', attempt.path, attempt.body, key);
      const body = await response.text();
      expect([200, 403], body).toContain(response.status);
      evidence.push(`PUT ${attempt.path} foreign actingSubject, replay=${replay}: ${response.status} ${body}`);
    }
  }
  const [afterWhole, afterPart, afterState, afterShelf] = await Promise.all([
    answer<Standing>(victim.main('GET', `${wholePath()}?${acting(victim)}`)),
    answer<Mark>(victim.main('GET', `${partPath()}?${acting(victim)}`)),
    answer<ReaderState>(victim.main('GET', statePath(game, victim))), shelf(),
  ]);
  expect(afterWhole).toEqual(beforeWhole);
  expect(afterPart).toEqual(beforePart);
  expect(afterState.status).toEqual(beforeState.status);
  const beforeOrder = before.items.map(item => item.work);
  const afterOrder = afterShelf.items.map(item => item.work);
  if (JSON.stringify(beforeOrder) !== JSON.stringify(afterOrder)) {
    console.error(JSON.stringify({ row: declaration.rowId, persona: name,
      requests: evidence, beforeOrder, afterOrder }));
  }
  expect(afterOrder, evidence.join('\n')).toEqual(beforeOrder);
}

const devices = new Map<PersonaName, PersonaSession>();
async function device(person: PersonaSession): Promise<PersonaSession> {
  const directory = join('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const configDirectory = readdirSync(directory).filter(name => name.startsWith('g-1005-auth-'));
  if (configDirectory.length !== 1) throw new Error('Expected the active persona OAuth client fixture');
  const config = JSON.parse(readFileSync(join(directory, configDirectory[0]!, 'public.json'), 'utf8')) as {
    clientId: string; redirectUris: string[]; scope: string;
  };
  // Account's existing cookie authenticates a fresh PKCE authorization, yielding a
  // distinct OAuth device grant. Tokens are never shared with the first device.
  const oauth = await signIn({ account: Bun.env.ACCOUNT_BASE_URL!,
    clientId: config.clientId, redirectUri: config.redirectUris[0]!, scope: config.scope,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname.endsWith('/token')) return fetch(input, init);
      return person.account(init?.method ?? 'GET', url.pathname + url.search,
        init?.body ? JSON.parse(String(init.body)) : undefined);
    },
  }, '');
  const sessionKey = randomUUID();
  return { ...person, main: async (method, path, body, key) => {
    const headers = new Headers({ authorization: `Bearer ${await oauth.current()}`, 'x-session-key': sessionKey });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (method !== 'GET') headers.set('idempotency-key', key ?? randomUUID());
    const request = (signal: AbortSignal) => fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
      method, headers, signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return method === 'GET' ? outcomeResponse(request) : request(AbortSignal.timeout(30_000));
  }};
}
beforeAll(async () => {
  await setupProgress();
  for (const name of ['stranger', 'member', 'owner', 'moderator', 'operator'] as const) {
    const second = await device(sessions[name]);
    const identity = await fixture<{ user: { id: string } }>(second.account('GET', '/api/auth/get-session'));
    if (identity.user.id !== sessions[name].accountId) throw new Error('Device Account identity mismatch');
    devices.set(name, second);
  }
}, 180_000);

async function continuity(name: PersonaName) {
  const a = sessions[name];
  if (name === 'visitor') {
    const member = sessions.member;
    const before = await answer(member.main('GET', `${wholePath()}?${acting(member)}`));
    for (const path of [`${wholePath()}?${acting(member)}`, `${partPath()}?${acting(member)}`,
      `/v1/compositions/${short(structure)}/progress?${acting(member)}`, summaryPath(game, member)])
      await answer(a.main('GET', path), 401);
    await answer(a.main('PUT', wholePath(), { actingSubject: member.actingSubject,
      expectedVersion: 0, standing: 'completed' }), 401);
    await answer(a.main('PUT', partPath(), { actingSubject: member.actingSubject,
      expectedVersion: 0, completed: true, position: 'completed' }), 401);
    expect(await answer(member.main('GET', `${wholePath()}?${acting(member)}`))).toEqual(before);
    return;
  }
  const b = devices.get(name)!;
  await status(a, game, 'want-to-read');
  for (const [path, start, finish, undo] of [
    [wholePath(), { standing: 'started' }, { standing: 'completed' }, { standing: 'not-started' }],
    [partPath(), { completed: false, position: 'played' },
      { completed: true, position: 'completed' }, { completed: false, position: null }],
  ] as const) {
    const initial = await answer<{ version: number }>(b.main('GET', `${path}?${acting(b)}`));
    const key = randomUUID();
    const command = { actingSubject: a.actingSubject, expectedVersion: initial.version, ...start };
    const saved = await answer<{ version: number }>(a.main('PUT', path, command, key));
    expect(saved.version).toBe(initial.version + 1);
    expect(await answer(b.main('GET', `${path}?${acting(b)}`))).toMatchObject({ ...start, version: saved.version });
    expect(await answer(b.main('PUT', path, command, key))).toMatchObject({ ...start, version: saved.version, replayed: true });
    expect(await answer(b.main('PUT', path, { ...command, ...finish }, key), 409))
      .toMatchObject({ code: 'progress_conflict' });
    expect(await answer(b.main('PUT', path, { ...command, ...finish }), 409))
      .toMatchObject({ code: 'stale_progress' });
    const winner = await answer<{ version: number }>(b.main('GET', `${path}?${acting(b)}`));
    const completed = await answer<{ version: number }>(b.main('PUT', path, {
      actingSubject: b.actingSubject, expectedVersion: winner.version, ...finish }));
    expect(await answer(a.main('GET', `${path}?${acting(a)}`))).toMatchObject({ ...finish, version: completed.version });
    if (path === wholePath()) {
      expect(await answer(b.main('GET', summaryPath(game, b))))
        .toMatchObject({ status: 'finished', counts: { completed: 1, completedRequired: 1 } });
    }
    const undone = await answer<{ version: number }>(a.main('PUT', path, {
      actingSubject: a.actingSubject, expectedVersion: completed.version, ...undo }));
    expect(await answer(b.main('GET', `${path}?${acting(b)}`))).toMatchObject({ ...undo, version: undone.version });
    const other = name === 'member' ? sessions.stranger : sessions.member;
    const otherBase = await answer<{ version: number }>(other.main('GET', `${path}?${acting(other)}`));
    const independent = await answer<{ version: number; replayed?: boolean }>(other.main('PUT', path, {
      actingSubject: other.actingSubject, expectedVersion: otherBase.version, ...start }, key));
    expect(independent.replayed).not.toBe(true);
    expect(independent.version).toBe(otherBase.version + 1);
    expect(await answer(b.main('GET', `${path}?${acting(b)}`))).toMatchObject({ ...undo, version: undone.version });
  }
  expect(await answer(b.main('GET', summaryPath(game, b))))
    .toMatchObject({ status: 'not-started', counts: { completed: 0 } });
  await privateBoundary(a, name);
}

outcomeTest(declaration, 'visitor', () => continuity('visitor'));

outcomeTest(declaration, 'stranger', () => continuity('stranger'));

outcomeTest(declaration, 'member', () => continuity('member'));

outcomeTest(declaration, 'owner', () => continuity('owner'));

outcomeTest(declaration, 'moderator', () => continuity('moderator'));

outcomeTest(declaration, 'operator', () => continuity('operator'));

