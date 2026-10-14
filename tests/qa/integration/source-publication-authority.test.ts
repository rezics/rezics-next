import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AccessPlatformAdministrators, platformResourceAuthority } from '../../../services/main/src/modules/access/platform-administrator.ts';
import { platformPermissionProof } from '../../../services/main/src/modules/access/platform-permissions.ts';
import { reduceFixtureGrant } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { personaSessions, type PersonaName, type PersonaSessions } from '../support/personas.ts';

const permission = 'platform:resource:work.publish';
const assignment = 'access.grant.assign.work.publish';
const scope = `work:publish:https://rezics.com/id/${randomUUID()}`;
const otherScope = `work:publish:https://rezics.com/id/${randomUUID()}`;
type Grant = { id: string; generation: string; scopeId: string; permission: string; receipt: string };
let sessions: PersonaSessions;
let pool: Pool;
let operatorId: string;
let memberId: string;
let issuer: string;

async function answer<T>(pending: Promise<Response>, status = 200): Promise<T> {
  const response = await pending, raw = await response.text();
  expect(response.status, raw).toBe(status);
  return JSON.parse(raw) as T;
}
async function epoch() {
  return (await answer<{ authorityEpoch: string }>(sessions.operator.main('GET',
    `/v1/access/grants?${new URLSearchParams({ profile: 'platform-grants-v1', issuerSubject: sessions.operator.actingSubject! })}`))).authorityEpoch;
}
async function issue(options: { name?: PersonaName; scopeId?: string; validUntil?: string | null;
  principalId?: string; permission?: string; key?: string; grantId?: string; expectedAuthorityEpoch?: string } = {}, status = 200) {
  const person = sessions[options.name ?? 'operator'];
  return answer<{ grant: Grant; authorityEpoch: string }>(person.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', action: 'create', issuerSubject: person.actingSubject,
    expectedAuthorityEpoch: options.expectedAuthorityEpoch ?? await epoch(),
    grantId: options.grantId ?? randomUUID(), permission: options.permission ?? permission,
    scopeId: options.scopeId ?? scope, recipient: { principalId: options.principalId ?? memberId },
    validUntil: options.validUntil === undefined ? null : options.validUntil,
  }, options.key), status);
}
async function revoke(grant: Grant) {
  return answer(sessions.operator.main('POST', '/v1/access/grant-changes', {
    profile: 'platform-grant-change-v1', action: 'revoke', issuerSubject: sessions.operator.actingSubject,
    expectedAuthorityEpoch: await epoch(), grantId: grant.id, expectedObjectGeneration: grant.generation,
  }));
}
async function authority(name: 'member' | 'operator', selectedScope = scope) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await platformResourceAuthority(client, { issuer, subject: sessions[name].accountId!, emailVerified: true },
      sessions[name].actingSubject!, 'work.publish', selectedScope);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

beforeAll(async () => {
  sessions = await personaSessions('public');
  pool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const principals = (await pool.query<{ id: string; account_subject: string; account_issuer: string }>(
    'SELECT id,account_subject,account_issuer FROM access.principal WHERE account_subject = ANY($1)',
    [[sessions.operator.accountId, sessions.member.accountId]])).rows;
  operatorId = principals.find(row => row.account_subject === sessions.operator.accountId)!.id;
  memberId = principals.find(row => row.account_subject === sessions.member.accountId)!.id;
  issuer = principals.find(row => row.id === operatorId)!.account_issuer;
}, 180_000);
afterAll(async () => { await pool?.end(); await sessions?.close(); });

test('only the deployment assignment authority delegates exact Work publication, with native replay and stale answers', async () => {
  const ceilings = await pool.query<{ id: string; recipient_subject: string; assigned_by_principal: string }>(
    'SELECT id,recipient_subject,assigned_by_principal FROM access.permission_grant WHERE action=$1', [assignment]);
  expect(ceilings.rows).toHaveLength(1);
  expect(ceilings.rows[0]).toMatchObject({ recipient_subject: sessions.operator.actingSubject,
    assigned_by_principal: operatorId });
  expect(await authority('operator')).toBeNull();
  for (const name of ['stranger', 'member', 'owner', 'moderator'] as const)
    expect(await issue({ name }, 403)).toMatchObject({ code: 'grant_denied' });
  for (const scopeId of ['work:publish:*', 'platform:access', `work:edit:${scope.slice('work:publish:'.length)}`,
    'work:publish:https://rezics.com/id/------------------------------------'])
    expect(await issue({ scopeId }, 403)).toMatchObject({ code: 'grant_denied' });
  const expectedAuthorityEpoch = await epoch(), key = randomUUID(), grantId = randomUUID();
  const first = await issue({ key, grantId, expectedAuthorityEpoch });
  expect(first.grant).toMatchObject({ id: grantId, permission, scopeId: scope });
  expect(first.grant.receipt).toStartWith('urn:rezics:access-receipt:');
  expect(await issue({ key, grantId, expectedAuthorityEpoch })).toEqual(first);
  expect(await issue({ expectedAuthorityEpoch }, 409)).toMatchObject({ code: 'grant_stale' });
  expect(await issue({ key, grantId, expectedAuthorityEpoch, scopeId: otherScope }, 409))
    .toMatchObject({ code: 'idempotency_conflict' });
  expect(await authority('member')).toBe(memberId);
  expect(await authority('member', otherScope)).toBeNull();
  // Receiving a resource mandate does not confer its assignment ceiling.
  expect(await issue({ name: 'member' }, 403)).toMatchObject({ code: 'grant_denied' });
  await revoke(first.grant);
  expect(await authority('member')).toBeNull();
  expect(await issue({ key, grantId, expectedAuthorityEpoch })).toEqual(first);
  expect(await authority('member')).toBeNull();
  const expired = await issue({ validUntil: new Date(Date.now() + 2_000).toISOString() });
  expect(await authority('member')).toBe(memberId);
  await Bun.sleep(2_100);
  expect(await authority('member')).toBeNull();
  await revoke(expired.grant);
  expect(await issue({ validUntil: new Date(Date.now() - 1_000).toISOString() }, 403))
    .toMatchObject({ code: 'grant_denied' });
}, 60_000);

test('a later platform grant holder and a status-only operator cannot acquire the deployment ceiling', async () => {
  const status = (await issue({ permission: 'platform:use:platform-admin', scopeId: 'platform:access' })).grant;
  expect(await authority('member')).toBeNull();
  expect(await issue({ name: 'member' }, 403)).toMatchObject({ code: 'grant_denied' });
  const holder = (await issue({ permission: 'platform:grant', scopeId: 'platform:access' })).grant;
  await pool.query('SELECT access.seed_source_publication_assignment_ceiling($1,$2)', [memberId, holder.receipt]);
  expect(await issue({ name: 'member' }, 403)).toMatchObject({ code: 'grant_denied' });
  expect((await pool.query('SELECT id FROM access.permission_grant WHERE action=$1 AND assigned_by_principal=$2',
    [assignment, memberId])).rows).toHaveLength(0);
  await revoke(holder);
  await revoke(status);
});

test('existing designation bootstrap is idempotent and preserves revoked ceilings and designation', async () => {
  const admins = new AccessPlatformAdministrators(pool);
  const before = (await pool.query<{ id: string; active: boolean }>('SELECT id,active FROM access.permission_grant WHERE action=$1', [assignment])).rows;
  expect(await admins.designateFirst(issuer, sessions.operator.accountId!, () => undefined))
    .toMatchObject({ status: 'ignored' });
  expect((await pool.query('SELECT id,active FROM access.permission_grant WHERE action=$1', [assignment])).rows).toEqual(before);
  // Keep governance available while ending the original designation episode.
  const successor = (await issue({ permission: 'platform:grant', scopeId: 'platform:access' })).grant;
  // Negative fixture authority ends a ceiling; issuance stays in API/bootstrap.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reduceFixtureGrant(client, before[0]!.id, { active: false });
    const designation = (await client.query<{ receipt: string }>(
      "SELECT receipt FROM access.platform_grant_episode WHERE permission='platform:grant' ORDER BY created_at,id LIMIT 1")).rows[0]!;
    await client.query('SELECT access.seed_platform_grants($1,$2)', [operatorId, designation.receipt]);
    expect((await client.query('SELECT id,active FROM access.permission_grant WHERE action=$1', [assignment])).rows)
      .toEqual(before.map(row => ({ ...row, active: false })));
    await client.query('UPDATE access.principal_permission_grant SET active=false WHERE principal_id=$1 AND action=$2',
      [operatorId, 'platform:grant']);
    await client.query('SELECT access.seed_platform_grants($1,$2)', [operatorId, designation.receipt]);
    expect(await platformPermissionProof(client, operatorId, 'platform:grant')).toBeNull();
    expect((await client.query('SELECT id,active FROM access.permission_grant WHERE action=$1', [assignment])).rows)
      .toEqual(before.map(row => ({ ...row, active: false })));
  } finally { await client.query('ROLLBACK'); client.release(); await revoke(successor); }
});

test('revoking a later ordinary governance grant preserves deployment publication assignment', async () => {
  const before = (await pool.query<{ id: string; active: boolean }>(
    'SELECT id,active FROM access.permission_grant WHERE action=$1', [assignment])).rows;
  expect(before).toHaveLength(1);
  expect(before[0]!.active).toBe(true);
  const successor = (await issue({ permission: 'platform:grant', scopeId: 'platform:access', principalId: operatorId })).grant;
  await revoke(successor);
  expect((await pool.query('SELECT id,active FROM access.permission_grant WHERE action=$1', [assignment])).rows).toEqual(before);
  const mandate = (await issue()).grant;
  expect(await authority('member')).toBe(memberId);
  await revoke(mandate);
  expect(await authority('member')).toBeNull();
}, 60_000);
