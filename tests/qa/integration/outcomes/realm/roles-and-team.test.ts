import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import team from '../../../../../scripts/qa/cases/outcomes/realm/roles-and-team.ts';
import { OutcomeRecorder, outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(120_000);
let sessions: PersonaSessions;
const recording = new OutcomeRecorder(team);
let initialRole: string;
const root = () => `/v1/realms/${sessions.realm.slice(-36)}`;
const acting = (person: PersonaSession) =>
  `actingSubject=${encodeURIComponent(person.actingSubject ?? sessions.owner.actingSubject!)}`;
async function answer<T>(request: Promise<Response>, status = 200): Promise<T> {
  const response = await request,
    raw = await response.text();
  expect(response.status, `${response.status}: ${raw}`).toBe(status);
  return JSON.parse(raw) as T;
}
type Role = {
  id: string;
  permissions: string[];
  holders: { member: string }[] | null;
  moreHolders: boolean | null;
};
type Roles = { generation: string; cap: number; roles: Role[] };
type Impact = {
  digest: string;
  exact: boolean;
  affectedCount: number;
  generation: string;
  changes: { member: string; gained: string[]; lost: string[] }[];
};
type Receipt = { receiptId: string; generation: string; replayed: boolean; impact: Impact };
type Change =
  | { kind: 'role'; roleId: string; name: string; permissions: string[] }
  | { kind: 'assignment'; roleId: string; member: string; assigned: boolean; validUntil: string };
const assignment = (roleId: string, member: string, assigned = true): Change => ({
  kind: 'assignment',
  roleId,
  member,
  assigned,
  validUntil: new Date(Date.now() + 3_600_000).toISOString(),
});
async function preview(change: Change, person = sessions.owner, label?: string) {
  const basis = await answer<Roles>(person.main('GET', `${root()}/roles?${acting(person)}`));
  const command = {
    actingSubject: person.actingSubject,
    expectedGeneration: basis.generation,
    reason: 'Review the exact effective Realm permissions',
    change,
  };
  const request = label ? recording.session('owner', person).bind(null, label) : person.main;
  const impact = await answer<Impact>(request('POST', `${root()}/role-impact`, command));
  expect(impact.exact).toBe(true);
  expect(impact.affectedCount).toBe(impact.changes.length);
  return { command: { ...command, impactDigest: impact.digest }, impact };
}
async function change(change: Change) {
  const intent = await preview(change);
  const receipt = await answer<Receipt>(
    sessions.owner.main('POST', `${root()}/role-changes`, intent.command),
    201,
  );
  expect(receipt.impact).toEqual(intent.impact);
  return intent;
}
beforeAll(async () => {
  sessions = await personaSessions('private');
  await recording.prepare();
  const roles = await answer<Roles>(sessions.owner.main('GET', `${root()}/roles?${acting(sessions.owner)}`));
  initialRole = roles.roles[0]!.id;
}, 180_000);
afterAll(async () => {
  try { await recording.publish(); }
  finally { await sessions?.close(); }
});

async function renderRead(name: PersonaName, label: string, path: string, anonymous = false) {
  const response = await recording.session(name, anonymous ? sessions.visitor : sessions[name])(label, 'GET', path);
  const raw = await response.text();
  if (response.status >= 500) throw new Error(`${name} ${label}: GET ${path}: ${response.status}: ${raw}`);
  return { status: response.status, data: JSON.parse(raw) as { zone?: string; routeSegment?: string | null } };
}

async function frameSite(name: PersonaName, zoneLabel = 'frame-site', editor = true) {
  const person = sessions[name];
  const query = name === 'visitor' ? '' : `?${acting(person)}`;
  const zone = await renderRead(name, zoneLabel, `${root()}/zone${query}`);
  if (zone.status === 200 && zone.data.zone) {
    const zoneId = zone.data.zone.slice(-36);
    await Promise.all([
      renderRead(name, 'frame-site-presentation', `/v1/zones/${zoneId}/presentation${query}`),
      ...(editor && name !== 'visitor'
        ? [renderRead(name, 'frame-site-editor', `/v1/zones/${zoneId}/showcase-editor?${acting(person)}`)] : []),
    ]);
  }
}

async function pageSession(name: Exclude<PersonaName, 'visitor'>) {
  const person = sessions[name];
  await Promise.all([
    renderRead(name, 'session-agent', '/v1/me/session-agent'),
    renderRead(name, 'agent-choices', '/v1/me/agents?languages=en'),
    renderRead(name, 'acting-contexts', '/v1/me/acting-contexts?task=work.create'),
    renderRead(name, 'reading-preferences', `/v1/me/person-preferences?${acting(person)}`),
  ]);
  await renderRead(name, 'acting-agent-profile', `/v1/agents/${person.actingSubject!.slice(-36)}?${acting(person)}`);
}

async function refused(name: PersonaName) {
  const person = sessions[name],
    status = name === 'visitor' ? 401 : 403;
  const sample = recording.session(name, person);
  if (name !== 'visitor') await pageSession(name);
  await Promise.all([
    frameSite(name),
    renderRead(name, 'official-address', `/v1/addresses/resolve?scope=space&key=${sessions.realm.slice(-36)}`, true),
    ...(name !== 'visitor'
      ? [renderRead(name, 'members-role-filter', `${root()}/members?${acting(person)}&role=${initialRole}`)] : []),
    answer(sample('roles-denied', 'GET', `${root()}/roles?${acting(person)}`), status),
    answer(sample('members-denied', 'GET', `${root()}/members?${acting(person)}`), status),
    answer(
      sample('realm-header', 'GET', name === 'visitor' ? root() : `${root()}?${acting(person)}`),
      ['member', 'moderator'].includes(name) ? 200 : 404,
    ),
    answer(
      sample('frame-realm', 'GET', `${root()}?${acting(person)}&language=en`),
      name === 'visitor' ? 401 : ['member', 'moderator'].includes(name) ? 200 : 404,
    ),
    answer(sample('members-invitations', 'GET', `${root()}/invitations?${acting(person)}`), status),
  ]);
  const command = {
    actingSubject: person.actingSubject ?? sessions.owner.actingSubject,
    expectedGeneration: '0',
    reason: 'Unauthorized role edit',
    change: {
      kind: 'role',
      roleId: randomUUID(),
      name: 'Unapproved managers',
      permissions: ['realm.roles.manage'],
    },
  };
  await answer(sample('role-impact-denied', 'POST', `${root()}/role-impact`, command), status);
  await answer(
    person.main('POST', `${root()}/role-changes`, { ...command, impactDigest: '0'.repeat(64) }),
    status,
  );
}
outcomeTest(team, 'visitor', () => refused('visitor'), recording);
outcomeTest(team, 'stranger', () => refused('stranger'), recording);
outcomeTest(team, 'member', () => refused('member'), recording);

outcomeTest(team, 'owner', async () => {
  const owner = sessions.owner,
    stranger = sessions.stranger,
    moderator = sessions.moderator;
  const sample = recording.session('owner', owner);
  await pageSession('owner');
  await Promise.all([
    answer(sample('management-realm-header', 'GET', `${root()}?${acting(owner)}&language=en`)),
    answer(sample('roles-initial', 'GET', `${root()}/roles?${acting(owner)}`)),
    renderRead('owner', 'members-role-filter', `${root()}/members?${acting(owner)}&role=${initialRole}`),
    renderRead('owner', 'official-address', `/v1/addresses/resolve?scope=space&key=${sessions.realm.slice(-36)}`, true),
    answer(sample('member-roster', 'GET', `${root()}/members?${acting(owner)}`)),
    answer(recording.session('owner', sessions.visitor)('member-profile', 'GET', `/v1/agents/${sessions.member.actingSubject!.slice(-36)}`)),
    answer(sample('member-search-empty', 'GET', `${root()}/members?${acting(owner)}&search=nomatch${randomUUID().replaceAll('-', '')}`)),
    answer(sample('outgoing-invitations-empty', 'GET', `${root()}/invitations?${acting(owner)}`)),
    frameSite('owner', 'management-site', false),
    renderRead('owner', 'site-editor-access', `/v1/zones/${sessions.zone.slice(-36)}/showcase-editor?${acting(owner)}`),
    answer(recording.session('owner', sessions.visitor)('holder-name-owner', 'GET', `/v1/agents/${owner.actingSubject!.slice(-36)}`)),
    answer(recording.session('owner', sessions.visitor)('holder-name-moderator', 'GET', `/v1/agents/${moderator.actingSubject!.slice(-36)}`)),
  ]);
  const roleId = randomUUID();
  const created = await change({
    kind: 'role',
    roleId,
    name: 'Delegated role managers',
    permissions: ['realm.roles.manage'],
  });
  expect(created.impact.changes).toEqual([]);
  await answer(sample('roles-unassigned', 'GET', `${root()}/roles?${acting(owner)}`));
  const intent = await preview(assignment(roleId, stranger.actingSubject!), owner, 'role-impact-preview'),
    key = randomUUID();
  expect(intent.impact.changes).toEqual([
    { member: stranger.actingSubject, gained: ['realm.roles.manage'], lost: [],
      jurisdictions: [{ targetScope: null, gained: ['realm.roles.manage'], lost: [] }] },
  ]);
  const receipt = await answer<Receipt>(
    sample('role-assignment-receipt', 'POST', `${root()}/role-changes`, intent.command, key),
    201,
  );
  expect(receipt.impact).toEqual(intent.impact);
  await answer(sample('roles-assigned', 'GET', `${root()}/roles?${acting(owner)}`));
  await answer(recording.session('owner', sessions.visitor)('holder-name-stranger', 'GET', `/v1/agents/${stranger.actingSubject!.slice(-36)}`));
  expect(
    await answer(owner.main('POST', `${root()}/role-changes`, intent.command, key)),
  ).toMatchObject({ receiptId: receipt.receiptId, replayed: true });
  await answer(
    sample(
      'role-intent-conflict', 'POST',
      `${root()}/role-changes`,
      { ...intent.command, reason: 'Different intent' },
      key,
    ),
    409,
  );
  await answer(owner.main('POST', `${root()}/role-impact`, intent.command), 400);
  const { impactDigest: _digest, ...stale } = intent.command;
  await answer(owner.main('POST', `${root()}/role-impact`, stale), 409);
  const roles = await answer<Roles>(stranger.main('GET', `${root()}/roles?${acting(stranger)}`));
  expect(roles.roles.length).toBeGreaterThan(0);
  for (const role of roles.roles) expect(role).toMatchObject({ holders: null, moreHolders: null });
  await answer(stranger.main('GET', `${root()}/members?${acting(stranger)}`), 403);
  await answer(stranger.main('GET', `${root()}?${acting(stranger)}`), 404);
  const roster = await answer<{
    items: { member: string; state: string; joinedAt: string | null; roles: { id: string }[] }[];
  }>(
    owner.main(
      'GET',
      `${root()}/members?${acting(owner)}&search=${encodeURIComponent(stranger.actingSubject!)}`,
    ),
  );
  expect(roster.items).toMatchObject([
    {
      member: stranger.actingSubject,
      state: 'not_joined',
      joinedAt: null,
      roles: [{ id: roleId }],
    },
  ]);
  const delegated = await preview(
    { kind: 'role', roleId: randomUUID(), name: 'Delegated empty role', permissions: [] },
    stranger,
  );
  await answer(stranger.main('POST', `${root()}/role-changes`, delegated.command), 201);
  await answer(sessions.operator.main('GET', `${root()}/roles?${acting(stranger)}`), 403);

  const independentRole = randomUUID();
  await change({
    kind: 'role',
    roleId: independentRole,
    name: 'Independent moderation assignment',
    permissions: ['governance.moderate'],
  });
  expect(
    (await change(assignment(independentRole, moderator.actingSubject!))).impact.changes,
  ).toEqual([]);
  expect(
    (await change(assignment(independentRole, moderator.actingSubject!, false))).impact.changes,
  ).toEqual([]);
  await answer(moderator.main('GET', `${root()}/moderation?${acting(moderator)}`));
  await change(assignment(roleId, stranger.actingSubject!, false));
  await answer(stranger.main('GET', `${root()}/roles?${acting(stranger)}`), 403);

  const race = await preview({
    kind: 'role',
    roleId,
    name: 'Concurrent role edit',
    permissions: [],
  });
  const results = await Promise.all([
    owner.main('POST', `${root()}/role-changes`, race.command),
    owner.main('POST', `${root()}/role-changes`, race.command),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
  const basis = await answer<Roles>(owner.main('GET', `${root()}/roles?${acting(owner)}`));
  for (let index = basis.roles.length; index < basis.cap; index++)
    await change({
      kind: 'role',
      roleId: randomUUID(),
      name: `Budget role ${index}`,
      permissions: [],
    });
  const full = await answer<Roles>(owner.main('GET', `${root()}/roles?${acting(owner)}`));
  expect(full.roles.length).toBe(full.cap);
  await answer(
    sample('role-budget-refused', 'POST', `${root()}/role-impact`, {
      actingSubject: owner.actingSubject,
      expectedGeneration: full.generation,
      reason: 'Check the declared role budget',
      change: { kind: 'role', roleId: randomUUID(), name: 'Overflow role', permissions: [] },
    }),
    422,
  );
  expect(
    (await answer<Roles>(owner.main('GET', `${root()}/roles?${acting(owner)}`))).generation,
  ).toBe(full.generation);
}, recording);
outcomeTest(team, 'moderator', async () => {
  await refused('moderator');
  await answer(
    sessions.moderator.main('GET', `${root()}/moderation?${acting(sessions.moderator)}`),
  );
}, recording);
outcomeTest(team, 'operator', async () => {
  expect(await answer(recording.session('operator', sessions.operator)('platform-access', 'GET', '/v1/me/platform-access'))).toMatchObject({
    groups: ['platform-admin'],
  });
  await refused('operator');
  await answer(sessions.operator.main('GET', `${root()}/roles?${acting(sessions.owner)}`), 403);
}, recording);
