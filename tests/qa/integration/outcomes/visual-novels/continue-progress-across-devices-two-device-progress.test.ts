import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import continuity from '../../../../../scripts/qa/cases/outcomes/visual-novels/continue-progress-across-devices-two-device-progress.ts';
import { signIn } from '../../../../../scripts/lib/oauth-client.ts';
import { outcomeResponse, outcomeTest } from '../../../support/outcome-test.ts';
import { personaSessions, type PersonaName, type PersonaSession, type PersonaSessions } from '../../../support/personas.ts';

setDefaultTimeout(60_000);
const short = (id: string) => id.slice(-36);
const query = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
let sessions: PersonaSessions;
const pairs = new Map<PersonaName, string[]>();
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request;
  const raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
beforeAll(async () => {
  sessions = await personaSessions('public');
  const owner = sessions.owner;
  const actingSubject = owner.actingSubject;
  for (const name of ['visitor', 'member', 'owner'] as const) {
    const pair: string[] = [];
    for (let index = 0; index < 2; index++) {
      const work = await answer<{ work: string; mainVersion: string }>(owner.main('POST', '/v1/works', {
        profile: 'metadata-only-v1', title: `Orchard Continuity ${name} ${index}`, language: 'en',
        semanticTypes: ['https://schema.org/VideoGame'], authoring: 'own-work', actingSubject,
      }), 201);
      const draft = await answer<{ contribution: string; draftRevision: string }>(owner.main('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: work.work, language: 'en',
        body: `An original partless visual novel: gardener ${index} chooses a path through an orchard.`, actingSubject,
      }), 201);
      const publication = await answer<{ publicationDecision: string }>(owner.main('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject,
      }), 201);
      await answer(owner.main('POST', '/v1/publication-selections', {
        profile: 'main-default-selection-v1', context: { kind: 'main-version-default', id: work.mainVersion },
        work: work.work, contribution: draft.contribution, publicationDecision: publication.publicationDecision,
        expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject,
      }), 201);
      pair.push(work.work);
    }
    pairs.set(name, pair);
  }
  for (const name of ['stranger', 'moderator', 'operator'] as const) pairs.set(name, pairs.get('visitor')!);
}, 180_000);
afterAll(async () => { await sessions?.close(); });
type State = { status: { work: string; status: string | null; version: number; changedAt: string | null }; progress: unknown };
type Mark = { standing: string; version: number; replayed?: boolean };
const state = (person: PersonaSession, work: string) => answer<State>(person.main('GET', `/v1/works/${short(work)}/reader-state?${query(person)}`));
const mark = (person: PersonaSession, work: string) => answer<Mark>(person.main('GET', `/v1/works/${short(work)}/progress?${query(person)}`));
const status = (person: PersonaSession, work: string, value: string | null, version: number) => answer(person.main('PUT', `/v1/works/${short(work)}/reader-status`, { actingSubject: person.actingSubject, status: value, expectedVersion: version }));
const progress = (person: PersonaSession, work: string, standing: string, expectedVersion: number, key?: string) => answer<Mark>(person.main('PUT', `/v1/works/${short(work)}/progress`, { actingSubject: person.actingSubject, standing, expectedVersion }, key));
async function shelf(person: PersonaSession, selected: string[]) {
  const params = new URLSearchParams({ actingSubject: person.actingSubject!, sort: 'last-read', order: 'desc', limit: '1' });
  const seen: string[] = [];
  let page: { items: Array<{ work: string }>; nextCursor: string | null };
  do {
    page = await answer(person.main('GET', `/v1/me/shelves/status/reading/works?${params}`));
    seen.push(...page.items.map(item => item.work));
    if (page.nextCursor) params.set('cursor', page.nextCursor);
  } while (page.nextCursor);
  return seen.filter(work => selected.includes(work));
}

async function foreign(name: PersonaName) {
  const person = sessions[name];
  const victim = name === 'owner' ? sessions.member : sessions.owner;
  const [work, other] = pairs.get(name)! as [string, string];
  for (const id of [work, other]) {
    await status(victim, id, 'reading', (await state(victim, id)).status.version);
    await progress(victim, id, 'started', (await mark(victim, id)).version);
  }
  const before = await state(victim, work);
  const victimMark = await mark(victim, work);
  const shelvesBefore = await answer(victim.main('GET', `/v1/me/shelves?${query(victim)}`));
  const ownMark = await mark(person, work);
  expect(await shelf(victim, [work, other])).toEqual([other, work]);
  await answer(person.main('GET', `/v1/works/${short(work)}/reader-state?${query(victim)}`), 403);
  await answer(person.main('PUT', `/v1/works/${short(work)}/reader-status`, { actingSubject: victim.actingSubject, expectedVersion: 1, status: 'read' }), 403);
  // Standing belongs to the principal. A foreign subject must never project that principal's mark into the victim's library.
  const read = await person.main('GET', `/v1/works/${short(work)}/progress?${query(victim)}`);
  if (read.status === 200) expect(await read.json()).toMatchObject({ standing: ownMark.standing, version: ownMark.version });
  else expect(read.status).toBe(403);
  const path = `/v1/works/${short(work)}/progress`;
  const command = { actingSubject: victim.actingSubject, expectedVersion: ownMark.version, standing: 'completed' };
  const write = await person.main('PUT', path, command);
  const reply = await write.text();
  console.info(JSON.stringify({ row: continuity.rowId, persona: name, request: { method: 'PUT', path, body: command }, answer: { status: write.status, body: JSON.parse(reply) } }));
  expect([200, 403]).toContain(write.status);
  expect(await state(victim, work)).toEqual(before);
  expect(await mark(victim, work)).toEqual(victimMark);
  expect(await answer(victim.main('GET', `/v1/me/shelves?${query(victim)}`))).toEqual(shelvesBefore);
  expect(await shelf(victim, [work, other])).toEqual([other, work]);
}

async function secondDevice(person: PersonaSession): Promise<PersonaSession> {
  const stackDirectory = resolve('.temp/stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const directory = readdirSync(stackDirectory).find(name => name.startsWith('g-1005-auth-'));
  if (!directory) throw new Error('No persona OAuth client configuration');
  const config = JSON.parse(readFileSync(resolve(stackDirectory, directory, 'public.json'), 'utf8')) as { clientId: string; redirectUris: string[]; scope: string };
  // Account authenticates this fresh PKCE authorization using the reader's real cookie.
  // The second device receives a separate OAuth grant and Main session key.
  const oauth = await signIn({ account: Bun.env.ACCOUNT_BASE_URL!, clientId: config.clientId,
    redirectUri: config.redirectUris[0]!, scope: config.scope, resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === '/api/auth/oauth2/authorize') return person.account('GET', `${url.pathname}${url.search}`);
      if (url.pathname === '/api/account/consent') return person.account('POST', url.pathname, JSON.parse(String(init?.body)));
      return fetch(input, init);
    },
  }, '');
  const sessionKey = randomUUID();
  return { ...person, main: async (method, path, body, key) => {
    const headers = new Headers({ authorization: `Bearer ${await oauth.current()}`, 'x-session-key': sessionKey });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (method !== 'GET') headers.set('idempotency-key', key ?? randomUUID());
    const request = (signal: AbortSignal) => fetch(new URL(path, `http://127.0.0.1:${Bun.env.MAIN_PORT}`), {
      method, headers, signal, redirect: 'manual', ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return method === 'GET' ? outcomeResponse(request) : request(AbortSignal.timeout(30_000));
  } };
}

async function continueReading(name: PersonaName) {
  const person = sessions[name];
  const work = pairs.get(name)![0]!;
  const root = `/v1/works/${short(work)}`;
  if (name === 'visitor') {
    await answer(person.main('GET', `${root}/progress?${query(sessions.owner)}`), 401);
    await answer(person.main('PUT', `${root}/progress`, { actingSubject: sessions.owner.actingSubject, expectedVersion: 0, standing: 'started' }), 401);
    expect((await state(sessions.owner, work)).status).toMatchObject({ status: null, version: 0 });
    return;
  }
  if (['stranger', 'moderator', 'operator'].includes(name)) return foreign(name);
  const deviceB = await secondDevice(person);
  const initial = await mark(deviceB, work);
  expect(initial).toMatchObject({ parts: false, standing: 'not-started', version: 0 });
  expect(await progress(person, work, 'started', initial.version)).toMatchObject({ standing: 'started', version: 1 });
  expect(await mark(deviceB, work)).toMatchObject({ standing: 'started', version: 1 });
  expect(await answer(deviceB.main('PUT', `${root}/progress`, { actingSubject: person.actingSubject, expectedVersion: initial.version, standing: 'completed' }), 409)).toMatchObject({ code: 'stale_progress' });
  const current = await mark(deviceB, work);
  expect(current).toMatchObject({ standing: 'started', version: 1 });
  const key = randomUUID();
  const saved = await progress(deviceB, work, 'completed', current.version, key);
  expect(saved).toMatchObject({ standing: 'completed', version: 2 });
  expect(await progress(deviceB, work, 'completed', current.version, key)).toMatchObject({ ...saved, replayed: true });
  expect(await mark(person, work)).toMatchObject({ standing: 'completed', version: 2 });
  expect(await answer(person.main('GET', `/v1/me/progress-summaries/${short(work)}?${query(person)}`))).toMatchObject({ status: 'finished' });
  expect(await progress(deviceB, work, 'not-started', saved.version)).toMatchObject({ standing: 'not-started', version: 3 });
  expect(await mark(person, work)).toMatchObject({ standing: 'not-started', version: 3 });
  expect(await mark(sessions.stranger, work)).toMatchObject({ standing: 'not-started', version: 0 });
  if (name === 'owner') await foreign(name);
}

outcomeTest(continuity, 'visitor', () => continueReading('visitor'));
outcomeTest(continuity, 'stranger', () => continueReading('stranger'));
outcomeTest(continuity, 'member', () => continueReading('member'));
outcomeTest(continuity, 'owner', () => continueReading('owner'));
outcomeTest(continuity, 'moderator', () => continueReading('moderator'));
outcomeTest(continuity, 'operator', () => continueReading('operator'));
