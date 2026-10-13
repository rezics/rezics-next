import { afterAll, beforeAll, expect, setDefaultTimeout } from 'bun:test';
import { randomUUID } from 'node:crypto';
import team from '../../../../../scripts/qa/cases/outcomes/realm/roles-and-team.ts';
import { outcomeTest } from '../../../support/outcome-test.ts';
import {
  personaSessions,
  type PersonaName,
  type PersonaSession,
  type PersonaSessions,
} from '../../../support/personas.ts';

setDefaultTimeout(120_000);
let sessions: PersonaSessions;
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
async function preview(change: Change, person = sessions.owner) {
  const basis = await answer<Roles>(person.main('GET', `${root()}/roles?${acting(person)}`));
  const command = {
    actingSubject: person.actingSubject,
    expectedGeneration: basis.generation,
    reason: 'Review the exact effective Realm permissions',
    change,
  };
  const impact = await answer<Impact>(person.main('POST', `${root()}/role-impact`, command));
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
}, 180_000);
afterAll(async () => {
  await sessions?.close();
});

async function refused(name: PersonaName) {
  const person = sessions[name],
    status = name === 'visitor' ? 401 : 403;
  for (const path of ['roles', 'members'])
    await answer(person.main('GET', `${root()}/${path}?${acting(person)}`), status);
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
  await answer(person.main('POST', `${root()}/role-impact`, command), status);
  await answer(
    person.main('POST', `${root()}/role-changes`, { ...command, impactDigest: '0'.repeat(64) }),
    status,
  );
  await answer(
    person.main('GET', name === 'visitor' ? root() : `${root()}?${acting(person)}`),
    ['member', 'moderator'].includes(name) ? 200 : 404,
  );
}
outcomeTest(team, 'visitor', () => refused('visitor'));
outcomeTest(team, 'stranger', () => refused('stranger'));
outcomeTest(team, 'member', () => refused('member'));

outcomeTest(team, 'owner', async () => {
  const owner = sessions.owner,
    stranger = sessions.stranger,
    moderator = sessions.moderator;
  const roleId = randomUUID();
  const created = await change({
    kind: 'role',
    roleId,
    name: 'Delegated role managers',
    permissions: ['realm.roles.manage'],
  });
  expect(created.impact.changes).toEqual([]);
  const intent = await preview(assignment(roleId, stranger.actingSubject!)),
    key = randomUUID();
  expect(intent.impact.changes).toEqual([
    { member: stranger.actingSubject, gained: ['realm.roles.manage'], lost: [] },
  ]);
  const receipt = await answer<Receipt>(
    owner.main('POST', `${root()}/role-changes`, intent.command, key),
    201,
  );
  expect(receipt.impact).toEqual(intent.impact);
  expect(
    await answer(owner.main('POST', `${root()}/role-changes`, intent.command, key)),
  ).toMatchObject({ receiptId: receipt.receiptId, replayed: true });
  await answer(
    owner.main(
      'POST',
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
    owner.main('POST', `${root()}/role-impact`, {
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
});
outcomeTest(team, 'moderator', async () => {
  await refused('moderator');
  await answer(
    sessions.moderator.main('GET', `${root()}/moderation?${acting(sessions.moderator)}`),
  );
});
outcomeTest(team, 'operator', async () => {
  expect(await answer(sessions.operator.main('GET', '/v1/me/platform-access'))).toMatchObject({
    groups: ['platform-admin'],
  });
  await refused('operator');
  await answer(sessions.operator.main('GET', `${root()}/roles?${acting(sessions.owner)}`), 403);
});
