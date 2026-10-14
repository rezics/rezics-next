import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import team from '../../../../tests/qa/fixtures/outcomes/realm/roles-and-team.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { changeRole } from './commands.ts';
import { readMembers, readRealmHeader } from './read.ts';
import {
  mapRealmMembers, mapRealmRoles, problemOf, readManagementActor, readRealmMembersPage, readRealmRolesPage,
  readRealmTeamFrame, recordedRoleCommand, recordedRoleCommandKey, saveRecordedRole, type RealmTeamProblem,
} from './realm-team-recorded-page.ts';
import type { InvitationPage, MemberPage, RealmHeader, RoleImpact, RoleList, RoleReceipt } from './types.ts';

const record = team as AnswerRecord;
const locale = 'en';
const origin = 'https://recorded.invalid';
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

function sample(persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing ${persona} sample ${label}`);
  return found;
}

function problem(persona: AnswerPersona, label: string): { title: string; code: string; status: number } {
  const answer = sample(persona, label).answer;
  if (!answer || typeof answer !== 'object') throw new Error(`Missing problem on ${persona}/${label}`);
  const body = answer as { title?: unknown; code?: unknown; status?: unknown };
  if (typeof body.title !== 'string' || typeof body.code !== 'string' || typeof body.status !== 'number') {
    throw new Error(`Recorded ${persona}/${label} is not a problem`);
  }
  return { title: body.title, code: body.code, status: body.status };
}

function selection(persona: AnswerPersona, label: string, empty = false): RecordedSelection {
  const status = sample(persona, label).status;
  if (status >= 400 && status <= 599) return { label, state: 'error' };
  if (empty) return { label, state: 'empty' };
  if (status === 200 || status === 201 || status === 204) return { label, state: 'populated' };
  throw new Error(`Recorded ${persona}/${label} (${status}) has no page state`);
}

function realmId(persona: AnswerPersona, label: string): string {
  const id = new URL(sample(persona, label).path, origin).pathname.split('/')[3];
  if (!id) throw new Error(`Recorded ${label} has no realm`);
  return id;
}

function subjectOf(persona: AnswerPersona, label: string): string {
  const subject = new URL(sample(persona, label).path, origin).searchParams.get('actingSubject');
  if (!subject) throw new Error(`Recorded ${label} has no acting Subject`);
  return subject;
}

function sessionSubject(persona: AnswerPersona): string {
  const answer = sample(persona, 'session-agent').answer as { sessionAgent?: { actingSubject?: string } };
  const subject = answer.sessionAgent?.actingSubject;
  if (!subject) throw new Error(`Recorded ${persona} session agent has no acting Subject`);
  return subject;
}

function realmFor(persona: AnswerPersona): string {
  return realmId(persona, persona === 'owner' ? 'management-realm-header' : 'frame-realm');
}

function actorFor(persona: AnswerPersona): string {
  return persona === 'visitor' ? subjectOf(persona, 'roles-denied') : sessionSubject(persona);
}

interface Logged {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
  problem: RealmTeamProblem | null;
}

function open(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const transport = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  const requested: Logged[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const source = input instanceof Request ? input : new Request(input, init);
    const request = source.clone();
    const url = new URL(request.url);
    const pathname = url.pathname.startsWith(`${BFF_PREFIX}/`) ? url.pathname.slice(BFF_PREFIX.length) : url.pathname;
    const text = await request.text();
    let body: unknown = undefined;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = text; }
    }
    const entry: Logged = {
      method: request.method, path: pathname + url.search, body, idempotencyKey: request.headers.get('idempotency-key'),
      problem: null,
    };
    requested.push(entry);
    const response = await transport.fetcher(source);
    if (response.status >= 400) entry.problem = problemOf(response.status, await response.clone().json().catch(() => null));
    return response;
  }) as typeof fetch;
  const main = () => browserMainApi(origin, { fetcher });
  const anonymous = () => browserMainApi(origin, { anonymous: true, fetcher });
  return { main, anonymous, requested };
}

function actorSelections(persona: AnswerPersona): RecordedSelection[] {
  return ['acting-contexts', 'agent-choices', 'session-agent', 'acting-agent-profile'].map(label => selection(persona, label));
}

function frameSelections(persona: AnswerPersona): RecordedSelection[] {
  if (persona === 'owner') return [selection(persona, 'management-realm-header'), selection(persona, 'management-site')];
  if (persona === 'visitor') return [selection(persona, 'frame-realm')];
  return [selection(persona, 'frame-realm'), selection(persona, 'frame-site')];
}

const notOnThisPage = ['/showcase-editor', '/presentation', '/addresses/resolve', '/person-preferences', '/platform-access'];

function expectPageReads(requested: readonly Logged[]) {
  for (const piece of notOnThisPage) expect(requested.some(item => item.path.includes(piece))).toBe(false);
}

function problemEnding(requested: readonly Logged[], suffix: string): RealmTeamProblem | null {
  return requested.find(item => item.path.split('?')[0]?.endsWith(suffix) && item.problem)?.problem ?? null;
}

async function load(persona: AnswerPersona, selections: readonly RecordedSelection[], surface: 'roles' | 'members') {
  const opened = open(persona, selections);
  const realm = realmFor(persona);
  const actingSubject = actorFor(persona);
  const signedIn = persona !== 'visitor';
  const agent = signedIn ? await readManagementActor(opened.main(), locale) : {
    iri: actingSubject, label: null, handle: null, kind: null, path: null,
  };
  const clients = { main: opened.main(), anonymous: opened.anonymous() };
  const frameRead = signedIn
    ? readRealmTeamFrame(opened.main(), realm, agent.iri, locale)
    : readRealmHeader(opened.main(), realm, locale, agent.iri).then(header => ({
      header: header.ok ? header.data : null, siteHref: null as string | null,
    }));
  if (surface === 'roles') {
    const [frame, roles] = await Promise.all([
      frameRead, readRealmRolesPage(clients, { realm, actingSubject: agent.iri }),
    ]);
    return {
      opened, realm, agent, frame, agents: roles.agents,
      mapped: mapRealmRoles(roles.roles, problemEnding(opened.requested, '/roles')),
    };
  }
  const [frame, members] = await Promise.all([
    frameRead, readRealmMembersPage(clients, { realm, actingSubject: agent.iri }),
  ]);
  return {
    opened, realm, agent, frame, agents: members.agents,
    mapped: mapRealmMembers(members.page, members.roles, members.invitations, null,
      problemEnding(opened.requested, '/members')),
  };
}

test('owner populated roles keep the recorded name, holder, permission and generation', async () => {
  const answer = sample('owner', 'roles-initial').answer as RoleList;
  const holder = sample('owner', 'holder-name-moderator').answer as { id: string; displayName: string };
  const header = sample('owner', 'management-realm-header').answer as RealmHeader;
  const profile = sample('owner', 'acting-agent-profile').answer as { displayName: string };
  const loaded = await load('owner', [
    selection('owner', 'roles-initial'),
    selection('owner', 'holder-name-moderator'),
    ...actorSelections('owner'),
    ...frameSelections('owner'),
  ], 'roles');
  if (loaded.mapped.kind !== 'roles') throw new Error(`expected roles, received ${loaded.mapped.kind}`);
  expect(loaded.mapped.list.generation).toBe(answer.generation);
  expect(loaded.mapped.list.cap).toBe(answer.cap);
  expect(loaded.mapped.list.roles.map(role => role.name)).toEqual(answer.roles.map(role => role.name));
  expect(loaded.mapped.list.roles.map(role => role.permissions)).toEqual(answer.roles.map(role => role.permissions));
  expect(loaded.agents[holder.id]?.label).toBe(holder.displayName);
  expect(loaded.frame.header?.name.value).toBe(header.name.value);
  expect(loaded.frame.siteHref).toBeNull();
  expect(loaded.agent.label).toBe(profile.displayName);
  expect(loaded.agent.iri).toBe(sessionSubject('owner'));
  const holderPath = new URL(sample('owner', 'holder-name-moderator').path, origin).pathname;
  const names = loaded.opened.requested.filter(item => item.path.split('?')[0] === holderPath);
  expect(names).toHaveLength(1);
  expect(names[0]?.path.includes('?')).toBe(false);
  const realmHeader = loaded.opened.requested.find(item => item.path.split('?')[0] === `/v1/realms/${loaded.realm}`);
  expect(realmHeader?.path).toContain('language=en');
  expect(realmHeader?.path).toContain('actingSubject=');
  expect(loaded.opened.requested.some(item => item.path.includes('/zone') && item.path.includes('actingSubject='))).toBe(true);
  expectPageReads(loaded.opened.requested);
});

test('owner populated members keep recorded identities, joined state and accepted invitations', async () => {
  const roster = sample('owner', 'member-roster').answer as MemberPage;
  const invitations = sample('owner', 'outgoing-invitations-empty').answer as InvitationPage;
  const moderator = sample('owner', 'holder-name-moderator').answer as { id: string; displayName: string };
  const member = sample('owner', 'member-profile').answer as { id: string; displayName: string };
  const loaded = await load('owner', [
    selection('owner', 'member-roster'),
    selection('owner', 'outgoing-invitations-empty'),
    selection('owner', 'roles-initial'),
    selection('owner', 'holder-name-moderator'),
    selection('owner', 'member-profile'),
    ...actorSelections('owner'),
    ...frameSelections('owner'),
  ], 'members');
  if (loaded.mapped.kind !== 'members') throw new Error(`expected members, received ${loaded.mapped.kind}`);
  expect(loaded.mapped.empty).toBe(false);
  expect(loaded.mapped.page.generation).toBe(roster.generation);
  expect(loaded.mapped.page.nextCursor).toBe(roster.nextCursor);
  expect(loaded.mapped.page.items.map(item => [item.member, item.state, item.roles.map(role => role.name)]))
    .toEqual(roster.items.map(item => [item.member, item.state, item.roles.map(role => role.name)]));
  expect(loaded.agents[moderator.id]?.label).toBe(moderator.displayName);
  expect(loaded.agents[member.id]?.label).toBe(member.displayName);
  expect(loaded.mapped.invitations.ok && loaded.mapped.invitations.data.items.map(item => [item.member, item.state]))
    .toEqual(invitations.items.map(item => [item.member, item.state]));
  expect(loaded.frame.siteHref).toBeNull();
  expect(loaded.opened.requested.some(item => item.path.includes('/invitations'))).toBe(true);
  expect(loaded.opened.requested.some(item => item.path.includes('role='))).toBe(false);
  expectPageReads(loaded.opened.requested);
});

test('owner member search with no matches stays an empty page and leaves the roster intact', async () => {
  const roster = sample('owner', 'member-roster').answer as MemberPage;
  const empty = sample('owner', 'member-search-empty');
  const query = new URL(empty.path, origin).searchParams.get('search');
  if (!query) throw new Error('Recorded member search has no query');
  const loaded = await load('owner', [
    selection('owner', 'member-roster'),
    selection('owner', 'member-search-empty', true),
    selection('owner', 'outgoing-invitations-empty'),
    selection('owner', 'roles-initial'),
    selection('owner', 'holder-name-moderator'),
    selection('owner', 'member-profile'),
    ...actorSelections('owner'),
    ...frameSelections('owner'),
  ], 'members');
  if (loaded.mapped.kind !== 'members') throw new Error(`expected members, received ${loaded.mapped.kind}`);
  expect(loaded.mapped.page.items).toHaveLength(roster.items.length);
  expect(loaded.mapped.empty).toBe(false);
  const searched = await readMembers(loaded.opened.main(), loaded.realm, { actingSubject: loaded.agent.iri, search: query });
  expect(searched.ok).toBe(true);
  if (!searched.ok) return;
  expect(searched.data.items).toHaveLength(0);
  expect(searched.data).toEqual(empty.answer as MemberPage);
});

test('owner saves the recorded assignment through its preview at the compare-and-set revision', async () => {
  const receipt = sample('owner', 'role-assignment-receipt');
  const previewAnswer = sample('owner', 'role-impact-preview').answer as RoleImpact;
  const answer = receipt.answer as RoleReceipt;
  const { command, impactDigest } = recordedRoleCommand(receipt.body);
  expect(impactDigest).toBe(previewAnswer.digest);
  const opened = open('owner', [
    selection('owner', 'role-impact-preview'),
    selection('owner', 'role-assignment-receipt'),
  ]);
  const realm = realmId('owner', 'role-assignment-receipt');
  const saved = await saveRecordedRole(opened.main(), realm, command, recordedRoleCommandKey);
  if (!saved.preview.ok) throw new Error(`recorded preview failed as ${saved.preview.failure}`);
  if (!saved.saved?.ok) throw new Error(`recorded save failed as ${saved.saved?.failure ?? 'absent'}`);
  expect(saved.preview.data.digest).toBe(previewAnswer.digest);
  expect(saved.saved.data.generation).toBe(answer.generation);
  expect(saved.saved.data.replayed).toBe(answer.replayed);
  expect(saved.saved.data.impact.digest).toBe(answer.impact.digest);
  expect(saved.saved.data.impact.generation).toBe(answer.impact.generation);
  expect(answer.impact.generation).toBe(command.expectedGeneration);
  expect(opened.requested.map(item => item.path.split('?')[0])).toEqual([
    `/v1/realms/${realm}/role-impact`, `/v1/realms/${realm}/role-changes`,
  ]);
  expect(opened.requested[1]?.idempotencyKey).toBe(recordedRoleCommandKey);
  expect((opened.requested[1]?.body as { impactDigest?: string }).impactDigest).toBe(saved.preview.data.digest);

  const assigned = sample('owner', 'roles-assigned').answer as RoleList;
  const stranger = sample('owner', 'holder-name-stranger').answer as { id: string; displayName: string };
  const loaded = await load('owner', [
    selection('owner', 'roles-assigned'),
    selection('owner', 'holder-name-moderator'),
    selection('owner', 'holder-name-stranger'),
    ...actorSelections('owner'),
    ...frameSelections('owner'),
  ], 'roles');
  if (loaded.mapped.kind !== 'roles') throw new Error(`expected assigned roles, received ${loaded.mapped.kind}`);
  expect(loaded.mapped.list.generation).toBe(answer.generation);
  expect(loaded.mapped.list.generation).toBe(assigned.generation);
  expect(loaded.agents[stranger.id]?.label).toBe(stranger.displayName);
  expect(loaded.mapped.list.roles.map(role => role.name)).toEqual(assigned.roles.map(role => role.name));
});

test('owner role command refusals keep the recorded problem', async () => {
  const budget = problem('owner', 'role-budget-refused');
  const budgetBody = recordedRoleCommand(sample('owner', 'role-budget-refused').body);
  expect(budgetBody.impactDigest).toBeNull();
  const budgetOpen = open('owner', [selection('owner', 'role-budget-refused')]);
  const preview = await saveRecordedRole(budgetOpen.main(), realmId('owner', 'role-budget-refused'), budgetBody.command,
    recordedRoleCommandKey);
  expect(preview.preview).toEqual({ ok: false, failure: 'budget', ...budget });
  expect(preview.saved).toBeNull();
  expect(budgetOpen.requested[0]?.problem).toEqual(budget);
  expect(budgetBody.command.expectedGeneration).toBe(
    (sample('owner', 'role-budget-refused').body as { expectedGeneration: string }).expectedGeneration);
  expect(budgetOpen.requested.map(item => item.path.split('?')[0])).toEqual([
    `/v1/realms/${realmId('owner', 'role-budget-refused')}/role-impact`,
  ]);

  const conflict = problem('owner', 'role-intent-conflict');
  const conflictBody = recordedRoleCommand(sample('owner', 'role-intent-conflict').body);
  if (!conflictBody.impactDigest) throw new Error('Recorded conflict has no impact digest');
  const conflictOpen = open('owner', [selection('owner', 'role-intent-conflict')]);
  const refused = await changeRole(conflictOpen.main(), realmId('owner', 'role-intent-conflict'), conflictBody.command,
    conflictBody.impactDigest, recordedRoleCommandKey);
  expect(refused).toEqual({ ok: false, failure: 'conflict', ...conflict });
  expect(conflictOpen.requested[0]?.problem).toEqual(conflict);
  expect(conflictOpen.requested[0]?.idempotencyKey).toBe(recordedRoleCommandKey);
  expect(conflictOpen.requested.map(item => item.path.split('?')[0])).toEqual([
    `/v1/realms/${realmId('owner', 'role-intent-conflict')}/role-changes`,
  ]);
});

const refused = ['visitor', 'stranger', 'member', 'moderator', 'operator'] as const;

function refusalSelections(persona: AnswerPersona, surface: 'roles' | 'members'): RecordedSelection[] {
  const page = surface === 'roles'
    ? [selection(persona, 'roles-denied')]
    : [selection(persona, 'members-denied'), selection(persona, 'roles-denied'), selection(persona, 'members-invitations')];
  return [...persona === 'visitor' ? [] : actorSelections(persona), ...frameSelections(persona), ...page];
}

for (const persona of refused) {
  test(`${persona} sees the recorded roles refusal and no role list`, async () => {
    const denied = sample(persona, 'roles-denied');
    const body = problem(persona, 'roles-denied');
    const loaded = await load(persona, refusalSelections(persona, 'roles'), 'roles');
    expect(loaded.mapped).toEqual({
      kind: 'refusal',
      failure: denied.status === 401 ? 'sign-in' : 'denied',
      problem: body,
    });
    expect(loaded.frame.siteHref).toBeNull();
    if (persona === 'visitor') expect(loaded.agent.label).toBeNull();
    else expect(loaded.agent.label).toBe((sample(persona, 'acting-agent-profile').answer as { displayName: string }).displayName);
    const header = sample(persona, 'frame-realm');
    if (header.status === 200) expect(loaded.frame.header?.name.value).toBe((header.answer as RealmHeader).name.value);
    else expect(loaded.frame.header).toBeNull();
    expect(loaded.opened.requested.some(item => item.path.includes('/zone'))).toBe(persona !== 'visitor');
    expectPageReads(loaded.opened.requested);
  });

  test(`${persona} sees the recorded members refusal and no roster`, async () => {
    const denied = sample(persona, 'members-denied');
    const body = problem(persona, 'members-denied');
    const loaded = await load(persona, refusalSelections(persona, 'members'), 'members');
    expect(loaded.mapped).toEqual({
      kind: 'refusal',
      failure: denied.status === 401 ? 'sign-in' : 'denied',
      problem: body,
    });
    expect(loaded.opened.requested.some(item => item.path.includes('/invitations'))).toBe(true);
    expect(loaded.opened.requested.some(item => item.path.includes('/roles'))).toBe(true);
    expectPageReads(loaded.opened.requested);
  });
}

test('readRealmHeader sends language and matches the recorded frame read', async () => {
  for (const persona of refused) {
    const header = sample(persona, 'frame-realm');
    const url = new URL(header.path, origin);
    expect(url.searchParams.get('language')).toBe('en');
    const subject = url.searchParams.get('actingSubject');
    if (!subject) throw new Error(`${persona} frame has no acting Subject`);
    const realm = url.pathname.split('/')[3]!;
    const opened = open(persona, [selection(persona, 'frame-realm')]);
    const read = await readRealmHeader(opened.main(), realm, locale, subject);
    if (header.status === 200) {
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.data.name.value).toBe((header.answer as RealmHeader).name.value);
    } else expect(read).toEqual({ ok: false, failure: header.status === 401 ? 'sign-in' : 'missing',
      problem: problemOf(header.status, header.answer) });
    expect(opened.requested).toHaveLength(1);
    expect(opened.requested[0]?.path).toContain('language=en');
    expect(opened.requested[0]?.path).toContain('actingSubject=');
    expect(sample(persona, 'realm-header').path.includes('language=')).toBe(false);
  }
});

test('visitor layout zone read sends actingSubject, which the recorded zone read omits', async () => {
  const subject = subjectOf('visitor', 'roles-denied');
  const realm = realmId('visitor', 'frame-realm');
  const opened = open('visitor', [selection('visitor', 'frame-realm'), selection('visitor', 'frame-site')]);
  await expect(readRealmTeamFrame(opened.main(), realm, subject, locale)).rejects.toThrow(/Unmatched recorded request/);
  const zone = opened.requested.find(item => item.path.includes('/zone'));
  expect(zone?.path).toContain('actingSubject=');
  expect(sample('visitor', 'frame-site').path.includes('actingSubject=')).toBe(false);
});
