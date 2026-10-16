import '../../../../../apps/web/tests/support/official-package-fixture.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mainRelationships } from '../../../../../apps/web/features/relationships/api.ts';
import { browserMainApi } from '../../../../../apps/web/features/api/browser.ts';
import { realmFrameReads } from '../../../../../apps/web/features/realm/zone-presentation-read.ts';
import { readAddress } from '../../../../../apps/web/features/address/client.ts';
import { readSpacePage } from '../../../../../apps/web/features/address/space-read.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import { closeRealm, closureCell } from './closure-fixture.ts';
import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import declaration from '../../../../../scripts/qa/cases/outcomes/realm/closure-roster.ts';
import {
  personaSessions, type PersonaName, type PersonaSession, type PersonaSessions,
} from '../../../support/personas.ts';

const { closureRosterClient, closureRosterRoute } = await import('../../../../../apps/web/features/realm/realm-closure-roster-recorded-page.tsx');

setDefaultTimeout(180_000);
const recording = new OutcomeRecorder(declaration);
const requestLabels = new AsyncLocalStorage<(path: string) => string>();
let closed: PersonaSessions;
let live: PersonaSessions;
let setupFailure: string | null = null;
let closureFailure: string | null = null;
let retainedCursor: string;
const absentRealm = `https://rezics.com/id/${randomUUID()}`;
const short = (id: string) => id.slice(-36);
const root = (sessions: PersonaSessions) => `/v1/realms/${short(sessions.realm)}`;
type Answer = { status: number; body: string };
async function command<T>(
  person: PersonaSession, method: string, path: string, body?: unknown,
  status = 200, key?: string,
): Promise<T> {
  const response = await person.main(method, path, body, key);
  const raw = await response.text();
  if (response.status !== status)
    throw new Error(`${method} ${path}: expected ${status}, received ${response.status} ${raw}`);
  return JSON.parse(raw) as T;
}

function concealed(failures: string[], path: string, answer: Answer, absent: Answer) {
  if (answer.status !== absent.status || JSON.stringify(JSON.parse(answer.body)) !==
      JSON.stringify(JSON.parse(absent.body))) {
    failures.push(`GET ${path}: ${answer.status} ${answer.body}; absent: ${absent.status} ${absent.body}`);
  }
}
function reportFailures(failures: string[]) {
  if (failures.length) console.log(failures.join('\n'));
  expect(failures, failures.join('\n')).toEqual([]);
}

async function listMembers(sessions: PersonaSessions) {
  for (const person of [sessions.member, sessions.moderator])
    await command(person, 'PUT', `${root(sessions)}/roster/listing`, {
      actingSubject: person.actingSubject, expectedMembershipGeneration: '1', listed: true,
    });
  await command(sessions.owner, 'PUT', `${root(sessions)}/roster/featured`, {
    actingSubject: sessions.owner.actingSubject, member: sessions.member.actingSubject,
    expectedMembershipGeneration: '1', featured: true,
  });
}
beforeAll(async () => {
  await recording.prepare();
  closed = await personaSessions('public');
  live = await personaSessions('public');
  try {
    await listMembers(closed);
    await listMembers(live);
    const first = await command<{ items: { agent: string }[]; nextCursor: string | null }>(
      closed.visitor, 'GET', `${root(closed)}/roster?limit=1`);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    retainedCursor = first.nextCursor!;
    const second = await command<{ items: { agent: string }[]; nextCursor: string | null }>(
      closed.visitor, 'GET', `${root(closed)}/roster?limit=1&after=${encodeURIComponent(retainedCursor)}`);
    expect([...first.items, ...second.items].map(item => item.agent).sort())
      .toEqual([closed.member.actingSubject!, closed.moderator.actingSubject!].sort());
    expect(second.nextCursor).toBeNull();
    const featured = await command<{ items: { agent: string }[] }>(
      closed.visitor, 'GET', `${root(closed)}/roster?featured=true`);
    expect(featured.items.map(item => item.agent)).toEqual([closed.member.actingSubject!]);
  } catch (error) { setupFailure = String(error); }
  closureFailure = await closeRealm(closed);
  if (setupFailure) console.log(`Roster prerequisite: ${setupFailure}`);
  if (closureFailure) console.log(`Roster closure prerequisite: ${closureFailure}`);
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); } finally { await closed?.close(); }
});

async function reads(name: PersonaName) {
  expect(closureFailure, closureFailure ?? '').toBeNull();
  expect(setupFailure, setupFailure ?? '').toBeNull();
  const person = closed[name];
  const failures: string[] = [];
  const observe = async (_person: PersonaSession, path: string): Promise<Answer> => {
    const query = new URL(path, 'https://recorded.invalid').searchParams;
    const target = path.startsWith(root(closed)) ? 'closed' : path.startsWith(root(live)) ? 'live' : 'absent';
    const kind = path.includes('/roles?') ? 'roles' : path.includes('/members?')
      ? `management-${query.has('after') ? 'retained' : query.has('limit') ? 'first' : query.has('search') ? 'search' : query.has('role') ? 'role' : 'all'}`
      : query.has('after') ? 'retained' : query.has('limit') ? 'first' : query.has('featured') ? 'featured' : 'roster';
    const response = await recording.session(name, person)(`${target}-${kind}`, 'GET', path);
    return { status: response.status, body: await response.text() };
  };
  for (const query of ['', '?featured=true', '?limit=1', `?limit=1&after=${encodeURIComponent(retainedCursor)}`]) {
    const path = `${root(closed)}/roster${query}`;
    // Absent currently returns 403. This qualifies equivalence without selecting
    // a new concealment status for the product.
    concealed(failures, path, await observe(person, path),
      await observe(person, `/v1/realms/${short(absentRealm)}/roster${query}`));
  }
  if (person.actingSubject) {
    const actor = `actingSubject=${encodeURIComponent(person.actingSubject)}`;
    for (const suffix of [`/members?${actor}`, `/members?${actor}&limit=1`,
      `/members?${actor}&limit=1&after=${encodeURIComponent(retainedCursor)}`,
      `/members?${actor}&search=Fixture`, `/members?${actor}&role=${randomUUID()}`, `/roles?${actor}`]) {
      const path = root(closed) + suffix;
      const answer = await observe(person, path);
      expect(answer.status, path).toBe(404);
      concealed(failures, path, answer, await observe(person, `/v1/realms/${short(absentRealm)}${suffix}`));
    }
  }
  if (name === 'owner') {
    const actor = `actingSubject=${encodeURIComponent(live.owner.actingSubject!)}`;
    const members = await command<{ items: { member: string }[] }>(live.owner, 'GET', `${root(live)}/members?${actor}`);
    expect(members.items.map(item => item.member).sort()).toEqual(
      [live.member.actingSubject!, live.moderator.actingSubject!].sort());
  }
  const controlPath = `${root(live)}/roster`;
  const control = await observe(person, controlPath);
  if (control.status !== 200)
    failures.push(`Live control GET ${controlPath}: ${control.status} ${control.body}`);
  else {
    const body = JSON.parse(control.body) as { items: { agent: string }[] };
    if (JSON.stringify(body.items.map(item => item.agent).sort()) !==
        JSON.stringify([live.member.actingSubject!, live.moderator.actingSubject!].sort()))
      failures.push(`Live consented members GET ${controlPath}: ${control.body}`);
  }
  reportFailures(failures);
}
async function within(milliseconds: number, part: string, run: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${part} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function productionVisit(name: PersonaName) {
  const person = closed[name];
  const originalFetch = globalThis.fetch;
  const origin = 'https://record.invalid';
  // RealmMembersRoute stops at loadRealmView's missing resolution, before readRoster.
  // Public frame reads have no bearer, including for a signed-in visitor.
  const publicRequest = recording.session(name, closed.visitor);
  const personalRequest = recording.session(name, person);
  const recorded = new Map<string, Promise<Response>>();
  const fetcher = (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin && url.origin !== 'https://recorded.invalid') return originalFetch(input, init);
    const path = url.pathname.replace(/^\/api\/main/, '') + url.search;
    const label = requestLabels.getStore()?.(path);
    if (!label) throw new Error(`Production request has no label: ${path}`);
    const personal = new Headers(init?.headers).has('authorization') || init?.credentials === 'same-origin';
    if (!recorded.has(label)) recorded.set(label, (personal ? personalRequest : publicRequest)(label, init?.method ?? 'GET', path));
    return (await recorded.get(label)!).clone();
  }) as typeof fetch;
  const main = browserMainApi(origin, { anonymous: true, fetcher });
  if (name === 'owner') {
    const actor = `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
    for (const [label, suffix] of [['management-members', '/members'], ['management-role-holders', '/roles']]) {
      const response = await personalRequest(label!, 'GET', `${root(closed)}${suffix}?${actor}`);
      expect(response.status).toBe(404);
    }
  }
  const named = <T,>(label: string, run: () => Promise<T>) => requestLabels.run(() => label, run);
  globalThis.fetch = fetcher;
  try {
    const frame = realmFrameReads({ main, keepProblem: false, resolution: {
      resolveAddress: (scope, key) => named('members-address', () =>
        readAddress({ scope, key }, 'en', origin, new Headers(), undefined, true)),
      readPrivateRealm: (ref, _locale, address) => requestLabels.run(path => {
        if (path.includes('/join-page')) return 'members-join-page';
        return 'members-private-header';
      }, () => readSpacePage(ref, 'en', {
        address, origin, incoming: new Headers(),
        ...(person.actingSubject ? { token: 'recorded-persona', actingSubject: person.actingSubject } : {}),
      })),
    } });
    const resolution = await frame.resolveRealm(short(closed.realm), 'en');
    if (resolution.kind === 'realm') throw new Error('Closed Realm unexpectedly opened the production members page');
    const client = closureRosterClient(fetcher, person.actingSubject ?? undefined);
    const labels = (prefix: string) => (path: string) => `${prefix}-${path.includes('/addresses/') ? 'address'
      : path.includes('/join-page') ? 'join-page' : path.includes('/session-agent') ? 'session-agent'
      : path.includes('/person-preferences') ? 'preferences' : path.includes('/platform-access') ? 'access'
      : path.includes('/joining') ? 'joining' : path.includes('/follow-state') ? 'follow-state' : path.includes('/follows/') ? 'follow'
      : path.includes('/zone') ? 'zone' : path.includes('/roster') ? 'roster'
      : path.includes('/ban') ? 'ban' : prefix === 'members' || path.includes('actingSubject=') ? 'private-header' : 'header'}`;
    await requestLabels.run(labels('members'), () => closureRosterRoute(client, short(closed.realm)));
    await requestLabels.run(labels('members'), () => closureRosterRoute(client, short(closed.realm), retainedCursor));
    await requestLabels.run(labels('live-page'), () => closureRosterRoute(client, short(live.realm)));
    // The rendered membership control refreshes its incomplete follow level after hydration.
    if (person.actingSubject) await requestLabels.run(labels('live-page'), () =>
      mainRelationships(person.actingSubject!, { origin: `${origin}/api/main`, fetch: fetcher }).state(live.realm));
  } finally { globalThis.fetch = originalFetch; }
}

async function qualify(name: PersonaName) {
  const started = Date.now();
  let proofMs = 0, visitStarted = 0;
  try {
    // The existing closureCell API proof owns its original 60 s deadline.
    await within(60_000, 'API proof', () => closureCell(declaration, name, () => closed, () => reads(name)));
    proofMs = Date.now() - started;
    visitStarted = Date.now();
    await within(120_000, 'production visit', () => productionVisit(name));
  } finally {
    console.info(`[persona-timing] ${name} proofMs=${proofMs || Date.now() - started} visitMs=${visitStarted ? Date.now() - visitStarted : 0}`);
  }
}
outcomeTest(declaration, 'visitor', () => qualify('visitor'), recording);
outcomeTest(declaration, 'stranger', () => qualify('stranger'), recording);
outcomeTest(declaration, 'member', () => qualify('member'), recording);
outcomeTest(declaration, 'owner', () => qualify('owner'), recording);
outcomeTest(declaration, 'moderator', () => qualify('moderator'), recording);
outcomeTest(declaration, 'operator', () => qualify('operator'), recording);
