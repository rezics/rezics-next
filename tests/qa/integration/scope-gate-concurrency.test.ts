import { AccessRevocations } from '../../../services/main/src/modules/access/revocation-requests.ts';
import { AccessAuthorityRead } from '../../../services/main/src/modules/access/authority-read.ts';
import { AccessPolicyChanges, POLICY_SET_ADMISSION } from '../../../services/main/src/modules/access/policy-changes.ts';
import { changeRealmMember } from '../../../services/main/src/modules/access/realm-management-members.ts';
import { receiptFamilyFor } from '../../../services/main/src/modules/access/receipt-families.ts';
import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied, AdmissionUnavailable,
  engageAccessRecoveryFence, releaseAccessRecoveryFence,
  type AdmissionRequest, type RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AccessMemberships, MembershipDenied, type MembershipChange } from '../../../services/main/src/modules/access/memberships.ts';
import { AccessPrivateMemberships } from '../../../services/main/src/modules/access/private-memberships.ts';
import { AccessRepresentations, RepresentationConflict } from '../../../services/main/src/modules/access/representations.ts';
import { AccessRepresentedMembershipAuthority } from '../../../services/main/src/modules/access/represented-membership-authority.ts';
import { AccessEligibleOrgMemberSet } from '../../../services/main/src/modules/access/eligible-org-member-set.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { AccessRoles } from '../../../services/main/src/modules/access/roles.ts';
import { AccessRealmJoining } from '../../../services/main/src/modules/access/realm-management-joining.ts';
import { RealmAdminDenied } from '../../../services/main/src/modules/realm-admin/contract.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';

const scope = 'work:create:root';
const native = () => `https://rezics.com/id/${randomUUID()}`;
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Independent command did not commit within one second')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const pool = new Pool({ connectionString: databases.urls.access });
  const principalId = randomUUID(), actor = native();
  const principal = { issuer: 'https://scope-gate.test', subject: randomUUID() };
  let workCreateGrant = '';
  try {
    await pool.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)`,
      [principalId, principal.issuer, principal.subject]);
    await pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [actor]);
    await pool.query(`INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING`, [scope]);
    for (const action of ['work.create', 'access.grant.assign.work.create', 'access.membership.consent',
      'access.membership.manage.realm', 'access.role.manage', 'access.revoke', POLICY_SET_ADMISSION]) {
      const grantId = randomUUID();
      if (action === 'work.create') workCreateGrant = grantId;
      await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
      await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [grantId, actor, scope, action]);
    }
  } catch (error) { await pool.end(); await databases.close(); throw error; }
  const registry = new AccessAdmissionRegistry(pool);
  const request = (key = randomUUID()): AdmissionRequest => ({ principal, actingSubject: actor, scope,
    action: 'work.create', idempotencyKey: key, requestDigest: 'a'.repeat(64) });
  const epoch = async () => (await pool.query<{ authority_epoch: string }>(
    'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!.authority_epoch;
  const cancelled = (row: RegisteredAdmission) => registry.recordGraphOutcome(row.id, {
    admissionId: row.id, scope: row.scope, requestDigest: row.requestDigest, authorityEpoch: row.authorityEpoch,
    receipt: `urn:rezics:receipt:${createHash('sha256').update(`${row.id}\0${receiptFamilyFor(row.action)}`).digest('hex')}`,
    outcome: 'cancelled', dataEpoch: 'scope-gate-fixture', sequence: '1',
  });
  return { pool, url: databases.urls.access, registry, actor, principal, principalId, workCreateGrant, request, epoch, cancelled,
    close: async () => { await pool.end(); await databases.close(); } };
}

async function waitsOnLock(pool: Pool, pid: number) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if ((await pool.query<{ waiting: boolean }>(
      "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error('Authority writer did not wait for the in-flight command');
}

test('Ordinary register, claim and seal share a scope while receipt retries serialize only their own key', async () => {
  const f = await fixture();
  const held = await f.pool.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await held.query('BEGIN');
    const intent = f.request();
    const first = await f.registry.register(intent, held);
    const retry = f.registry.register(intent);
    pending.push(retry);
    const independent = await within(f.registry.register(f.request()));
    expect((await within(f.registry.claim(independent.id, independent.requestDigest))).state).toBe('claimed');
    await within(f.cancelled(independent));
    expect((await f.pool.query('SELECT state FROM access.admission WHERE id = $1', [independent.id])).rows[0].state).toBe('sealed');
    await held.query('COMMIT');
    expect(await within(retry)).toMatchObject({ id: first.id, replayed: true });
    await expect(f.registry.register({ ...intent, requestDigest: 'b'.repeat(64) })).rejects.toBeInstanceOf(AdmissionConflict);
    const otherScope = 'work:create:separate';
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [otherScope]);
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.create',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.actor, otherScope]);
    await expect(f.registry.register({ ...intent, scope: otherScope })).rejects.toBeInstanceOf(AdmissionConflict);
    expect((await f.pool.query(`SELECT count(*)::int AS n FROM access.admission
      WHERE principal_id = $1 AND action = $2 AND idempotency_key = $3`,
    [f.principalId, intent.action, intent.idempotencyKey])).rows[0].n).toBe(1);
    await expect(f.registry.register({ ...f.request(), principal: { ...f.principal, subject: 'absent' } }))
      .rejects.toBeInstanceOf(AdmissionDenied);
    const generation = await engageAccessRecoveryFence(f.pool);
    try {
      await expect(f.registry.register(f.request())).rejects.toBeInstanceOf(AdmissionUnavailable);
      await expect(f.registry.claim(first.id, first.requestDigest)).rejects.toBeInstanceOf(AdmissionUnavailable);
      await expect(f.cancelled(first)).rejects.toBeInstanceOf(AdmissionUnavailable);
    } finally { await releaseAccessRecoveryFence(f.pool, generation); }
  } finally {
    await held.query('ROLLBACK'); held.release();
    await Promise.allSettled(pending);
    await f.close();
  }
}, 30_000);

for (const mutation of ['ordinary-close', 'strong-close', 'epoch'] as const) {
  test(`Scope ${mutation} waits for in-flight commands and refuses the old epoch at claim`, async () => {
    const f = await fixture();
    const held = await f.pool.connect();
    const writer = new Pool({ connectionString: f.url, max: 1 });
    const pending: Promise<unknown>[] = [];
    try {
      const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await held.query('BEGIN');
      const registered = await f.registry.register(f.request(), held);
      const owner = new AccessAdmissionRegistry(writer);
      const changing = mutation === 'epoch'
        ? writer.query('UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1 WHERE id = $1', [scope])
        : mutation === 'strong-close' ? owner.strongCloseScope(scope, registered.authorityEpoch)
          : owner.closeScope(scope, registered.authorityEpoch);
      pending.push(changing);
      await waitsOnLock(f.pool, pid);
      expect(await f.epoch()).toBe(registered.authorityEpoch);
      await held.query('COMMIT');
      await within(changing);
      await expect(f.registry.claim(registered.id, registered.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
      if (mutation === 'epoch') {
        expect((await f.registry.register(f.request())).authorityEpoch).toBe((BigInt(registered.authorityEpoch) + 1n).toString());
      } else {
        await expect(f.registry.register(f.request())).rejects.toBeInstanceOf(AdmissionDenied);
      }
      // Recovery seals the exact old receipt even after its scope has closed.
      await f.cancelled(registered);
    } finally {
      await held.query('ROLLBACK'); held.release();
      await Promise.allSettled(pending);
      await writer.end(); await f.close();
    }
  }, 30_000);
}

test('Public/private consent, representation requests and role revisions share unchanged authority with ordinary admissions', async () => {
  const f = await fixture();
  const held = await f.pool.connect();
  try {
    await held.query('BEGIN');
    await f.registry.register(f.request(), held);
    await f.pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('realm',$1,1,'terms')`, [f.actor]);
    const consents = new AccessMembershipConsents(f.pool);
    const consentIntent = { principal: f.principal, kind: 'realm' as const, ownerSubject: f.actor,
      memberSubject: f.actor, expectedGeneration: '0', expectedPolicyRevision: '1', termsRevision: 'terms',
      idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) };
    const issued = await within(Promise.all([consents.issue(consentIntent), consents.issue(consentIntent)]));
    expect(issued[0]!.consentReference).toBe(issued[1]!.consentReference);
    expect(issued.map(row => row.replayed).sort()).toEqual([false, true]);
    await within(consents.revoke(f.principal, issued[0]!.consentReference));
    const privateConsents = new AccessPrivateMemberships(f.pool);
    const privateIntent = { ...consentIntent, idempotencyKey: randomUUID() };
    const privateIssued = await within(Promise.all([privateConsents.issue(privateIntent), privateConsents.issue(privateIntent)]));
    expect(privateIssued[0]!.consentReference).toBe(privateIssued[1]!.consentReference);
    expect(privateIssued.map(row => row.replayed).sort()).toEqual([false, true]);
    await within(privateConsents.revoke(f.principal, privateIssued[0]!.consentReference));
    const other = native();
    await f.pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [other]);
    await f.pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('org',$1,1,'terms')`, [f.actor]);
    const requests = new AccessRepresentedMembershipAuthority(f.pool);
    const requestId = randomUUID(), requestKey = randomUUID(), validUntil = new Date(Date.now() + 60_000);
    const requested = await within(Promise.all([
      requests.request(f.principal, requestId, other, f.actor, validUntil, requestKey, 'e'.repeat(64)),
      requests.request(f.principal, requestId, other, f.actor, validUntil, requestKey, 'e'.repeat(64)),
    ]));
    expect(requested[0]).toEqual(requested[1]);
    await expect(within(new AccessRepresentations(f.pool).request(f.principal, randomUUID(), other,
      validUntil, requestKey, 'e'.repeat(64)))).rejects.toBeInstanceOf(RepresentationConflict);
    await expect(within(requests.readRequest(f.principal, f.actor, requestId))).rejects.toBeInstanceOf(MembershipDenied);
    await expect(within(new AccessEligibleOrgMemberSet(f.pool).read(f.principal, f.actor, randomUUID())))
      .rejects.toBeInstanceOf(MembershipDenied);
    const roles = new AccessRoles(f.pool), family = randomUUID();
    const roleIntent = { principal: f.principal, issuerSubject: f.actor, expectedAuthorityEpoch: await f.epoch(),
      idempotencyKey: randomUUID(), requestDigest: 'd'.repeat(64) };
    expect(await within(Promise.all([roles.createFamily(roleIntent, family, []),
      roles.createFamily(roleIntent, family, [])]))).toEqual(['1', '1']);
    await held.query('COMMIT');
  } finally { await held.query('ROLLBACK'); held.release(); await f.close(); }
}, 30_000);

test('Realm management reads and idle policy recovery share their Realm gate and revision', async () => {
  const f = await fixture();
  const held = await f.pool.connect();
  const realmScope = `governance:realm:${f.actor}`;
  try {
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [realmScope]);
    await f.pool.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1)', [f.actor]);
    for (const action of ['realm.roles.manage', 'realm.settings.manage']) {
      await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [randomUUID(), f.principalId, f.actor, action]);
      await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [randomUUID(), f.actor, realmScope, action]);
    }
    await held.query('BEGIN');
    await held.query('SELECT 1 FROM access.scope_gate WHERE id = $1 FOR SHARE', [realmScope]);
    await held.query('SELECT 1 FROM access.realm_admin_revision WHERE realm = $1 FOR SHARE', [f.actor]);
    const owner = new AccessRealmManagement(f.pool);
    expect(await within(owner.roles(f.principal, f.actor, f.actor))).toEqual({ generation: '0', roles: [] });
    expect((await within(owner.settings(f.principal, f.actor, f.actor))).generation).toBe('0');
  } finally { await held.query('ROLLBACK'); held.release(); await f.close(); }
}, 30_000);

test('Catalogue batch admissions and seals share their scope and order overlapping receipt locks', async () => {
  const f = await fixture();
  const held = await f.pool.connect();
  const pending: Promise<unknown>[] = [];
  const catalogueScope = 'work:create:catalogue-import';
  try {
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [catalogueScope]);
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.create',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.actor, catalogueScope]);
    const item = { key: randomUUID(), digest: 'a'.repeat(64) };
    await held.query('BEGIN');
    const saved = (await held.query<{ result: { items: { admission: { id: string } }[] } }>(
      'SELECT access.catalogue_import_admit($1,$2,$3,$4::jsonb) AS result',
      [f.principal.issuer, f.principal.subject, f.actor, JSON.stringify([item])])).rows[0]!.result;
    const retry = f.registry.admitCatalogue(f.principal, f.actor, [item]);
    pending.push(retry);
    const independent = await within(f.registry.admitCatalogue(f.principal, f.actor,
      [{ key: randomUUID(), digest: 'b'.repeat(64) }]));
    const row = independent[0]!;
    if (!('admission' in row)) throw new Error('Catalogue command was denied');
    expect(row.admission.state).toBe('claimed');
    const proof = { admissionId: row.admission.id, scope: catalogueScope, requestDigest: row.admission.requestDigest,
      authorityEpoch: row.admission.authorityEpoch,
      receipt: `urn:rezics:receipt:${createHash('sha256').update(`${row.admission.id}\0create-metadata-work`).digest('hex')}`,
      outcome: 'cancelled' as const, dataEpoch: 'scope-gate-fixture', sequence: '1' };
    await within(f.registry.recordCatalogueOutcomes([proof]));
    await held.query('COMMIT');
    expect(await within(retry)).toMatchObject([{ admission: { id: saved.items[0]!.admission.id, replayed: true } }]);
    const items = [randomUUID(), randomUUID()].sort().map(key => ({ key, digest: 'c'.repeat(64) }));
    const overlapping = await within(Promise.all([
      f.registry.admitCatalogue(f.principal, f.actor, items),
      f.registry.admitCatalogue(f.principal, f.actor, [...items].reverse()),
    ]));
    for (let batch = 0; batch < 2; batch++) {
      expect(overlapping[batch]!.map(value => 'admission' in value ? value.admission.idempotencyKey : null))
        .toEqual(batch === 0 ? items.map(value => value.key) : [...items].reverse().map(value => value.key));
    }
    expect((await f.pool.query(`SELECT count(*)::int AS n FROM access.admission
      WHERE principal_id = $1 AND idempotency_key = ANY($2::text[])`, [f.principalId, items.map(value => value.key)])).rows[0].n).toBe(2);
  } finally {
    await held.query('ROLLBACK'); held.release(); await Promise.allSettled(pending); await f.close();
  }
}, 30_000);

async function joiningFixture(f: Awaited<ReturnType<typeof fixture>>, realm = f.actor) {
  const member = native();
  await f.pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [member]);
  if (realm !== f.actor) {
    await f.pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [realm]);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'access.membership.manage.realm',clock_timestamp() + interval '1 hour')`,
    [randomUUID(), f.principalId, realm]);
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'access.membership.manage.realm',clock_timestamp() + interval '1 hour')`, [randomUUID(), realm, scope]);
  }
  await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'access.membership.consent',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.principalId, member]);
  await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
    VALUES ($1,$2,$3,$4,'access.membership.consent',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.actor, member, scope]);
  await f.pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
    VALUES ('realm',$1,1,'terms')`, [realm]);
  const consent = await new AccessMembershipConsents(f.pool).issue({ principal: f.principal, kind: 'realm',
    ownerSubject: realm, memberSubject: member, expectedGeneration: '0', expectedPolicyRevision: '1',
    termsRevision: 'terms', idempotencyKey: randomUUID(), requestDigest: 'e'.repeat(64) });
  const join: MembershipChange = { principal: f.principal, kind: 'realm', ownerSubject: realm,
    memberSubject: member, action: 'join', expectedGeneration: '0', expectedPolicyRevision: '1',
    termsRevision: 'terms', consentReference: consent.consentReference, idempotencyKey: randomUUID(), requestDigest: 'f'.repeat(64) };
  return { member, join };
}
function memberships(pool: Pool) {
  const owner = new AccessMemberships(pool);
  owner.configureFollowGraph(new FusekiClient(Bun.env.FUSEKI_URL!));
  return owner;
}
function heldCommit(pool: Pool) {
  const written = barrier(), release = barrier();
  pool.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (async (sql: string, values?: unknown[]) => {
      if (sql === 'COMMIT') { written.release(); await release.promise; }
      return query(sql, values);
    }) as typeof client.query;
  });
  return { written, release };
}

test('A Realm join held after its writes lets another Realm join, unrelated scope grant and Work admission commit within one second', async () => {
  const f = await fixture();
  const heldPool = new Pool({ connectionString: f.url, max: 1 });
  const held = heldCommit(heldPool);
  const pending: Promise<unknown>[] = [];
  try {
    const a = await joiningFixture(f), b = await joiningFixture(f, native());
    const org = native(), draftScope = `content:draft:${org}`;
    await f.pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'institution')`, [org]);
    await f.pool.query(`INSERT INTO access.org_participation_subject (subject) VALUES ($1)`, [org]);
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [draftScope]);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'access.grant.assign.content.draft',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.principalId, org]);
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'access.grant.assign.content.draft',clock_timestamp() + interval '1 hour')`, [randomUUID(), org, draftScope]);
    const joining = memberships(heldPool).change(a.join);
    pending.push(joining);
    await within(held.written.promise);
    const results = await within(Promise.all([
      memberships(f.pool).change(b.join),
      new AccessGrants(f.pool).createOrganizationContentDraft({ principal: f.principal, issuerSubject: org, expectedAuthorityEpoch: '0' },
        randomUUID(), b.member, new Date(Date.now() + 60_000), { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) }),
      f.registry.register(f.request()).then(async row => {
        await f.registry.claim(row.id, row.requestDigest); await f.cancelled(row); return row;
      }),
    ]));
    expect(results[0].generation).toBe('1');
    expect(results[1]).toBe('0');
    expect(results[2].authorityEpoch).toBe('0');
    expect(await f.epoch()).toBe('0');
    held.release.release();
    expect((await within(joining)).authorityEpoch).toBe('0');
    // A new root grant also shares an in-flight ordinary admission's scope fence.
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN'); await f.registry.register(f.request(), client);
      expect(await within(new AccessGrants(f.pool).create({ principal: f.principal, issuerSubject: f.actor,
        expectedAuthorityEpoch: '0' }, randomUUID(), a.member, new Date(Date.now() + 60_000),
      { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) }))).toBe('0');
    } finally { await client.query('ROLLBACK'); client.release(); }
  } finally {
    held.release.release(); await Promise.allSettled(pending); await heldPool.end(); await f.close();
  }
}, 30_000);

test('Realm membership revocation fences the exact dependent proof while independent authority in the same Realm remains dispatchable', async () => {
  const f = await fixture();
  const heldPool = new Pool({ connectionString: f.url, max: 1 });
  const held = heldCommit(heldPool);
  const pending: Promise<unknown>[] = [];
  try {
    const { member, join } = await joiningFixture(f);
    const joined = await memberships(f.pool).change(join);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.create',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.principalId, member]);
    await new AccessGrants(f.pool).create({ principal: f.principal, issuerSubject: f.actor, expectedAuthorityEpoch: '0' },
      randomUUID(), member, new Date(Date.now() + 60_000), { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) },
      { membershipId: joined.membershipId, generation: joined.generation });
    const dependentRequest = { ...f.request(), actingSubject: member };
    const dependent = await f.registry.register(dependentRequest);
    const independentRequest = f.request(), independent = await f.registry.register(independentRequest);
    const leaving = memberships(heldPool).change({ ...join, action: 'leave', expectedGeneration: '1',
      idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) });
    pending.push(leaving);
    await within(held.written.promise);
    // The independent proof does not use this Realm's membership, even though
    // its issuer owns that Realm. Neither its claim nor terminal seal waits.
    await within(f.registry.claim(independent.id, independent.requestDigest));
    await within(f.cancelled(independent));
    held.release.release(); await within(leaving);
    expect(await f.epoch()).toBe('0');
    await expect(f.registry.claim(dependent.id, dependent.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await f.registry.register(dependentRequest)).dispatchEligible).toBe(false);
    // An independent replacement source cannot revive the saved admission.
    await new AccessGrants(f.pool).create({ principal: f.principal, issuerSubject: f.actor, expectedAuthorityEpoch: '0' },
      randomUUID(), member, new Date(Date.now() + 60_000), { idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) });
    await expect(f.registry.claim(dependent.id, dependent.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await f.registry.register({ ...dependentRequest, idempotencyKey: randomUUID() })).dispatchEligible).toBe(true);
    // A cancellation is always acknowledged, including after its source ends.
    await f.cancelled(dependent);
  } finally {
    held.release.release(); await Promise.allSettled(pending); await heldPool.end(); await f.close();
  }
}, 30_000);

test('Joining policy graph preparation holds no Access gate, identity or recovery locks', async () => {
  const f = await fixture();
  const graphRead = barrier(), release = barrier();
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL!);
  const query = fuseki.query.bind(fuseki);
  const pending: Promise<unknown>[] = [];
  try {
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`governance:realm:${f.actor}`]);
    await f.pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision) VALUES ('realm',$1,1,'terms')`, [f.actor]);
    fuseki.query = async (...args) => { graphRead.release(); await release.promise; return query(...args); };
    const env: WorkActivationEnvironment = { fuseki, objectDirectory: Bun.env.MAIN_OBJECT_DIRECTORY!,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH!, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH! } };
    // An absent graph policy still fails closed after the unlocked preparation.
    const policy = new AccessRealmJoining(f.pool, env).policyFor(f.principal, f.actor, f.actor);
    pending.push(policy);
    await within(graphRead.promise);
    const probe = await f.pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM access.scope_gate WHERE id = $1 FOR UPDATE NOWAIT', [`governance:realm:${f.actor}`]);
      await probe.query('SELECT 1 FROM access.principal WHERE id = $1 FOR UPDATE NOWAIT', [f.principalId]);
    } finally { await probe.query('ROLLBACK'); probe.release(); }
    const generation = await within(engageAccessRecoveryFence(f.pool));
    await releaseAccessRecoveryFence(f.pool, generation);
    release.release();
    await expect(policy).rejects.toBeInstanceOf(RealmAdminDenied);
  } finally {
    release.release(); await Promise.allSettled(pending);
    fuseki.query = query; await f.close();
  }
}, 30_000);

test('Group proof generations cover only the selected member, grant and ancestry; unrelated roster edits do not invalidate them', async () => {
  const f = await fixture();
  try {
    await f.pool.query("DELETE FROM access.permission_grant WHERE recipient_subject = $1 AND action = 'work.create'", [f.actor]);
    const root = randomUUID(), child = randomUUID(), other = randomUUID(), memberId = randomUUID();
    await f.pool.query(`INSERT INTO access.recipient_group (id,scope_id,parent_id) VALUES ($1,$4,NULL),($2,$4,$1),($3,$4,NULL)`, [root, child, other, scope]);
    await f.pool.query(`INSERT INTO access.group_member (id,group_id,agent_subject) VALUES ($1,$2,$3)`, [memberId, child, f.actor]);
    await f.pool.query(`INSERT INTO access.group_permission_grant (id,group_id,issuer_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$3,$4,'work.create',clock_timestamp() + interval '1 hour')`, [randomUUID(), root, f.actor, scope]);
    const intent = f.request(), saved = await f.registry.register(intent);
    const inventory = (await f.pool.query("SELECT group_generation FROM access.scope_gate WHERE id = 'access:group-inventory'")).rows[0].group_generation;
    expect((await new AccessAuthorityRead(f.pool).read(f.principal, { scopeId: scope, actingSubject: f.actor, action: 'work.create' }))
      .groupGeneration).toBe(inventory);
    const proof = (await f.pool.query<{ authority_witness: { table: string; id: string }[] }>(
      'SELECT authority_witness FROM access.admission WHERE id = $1', [saved.id])).rows[0]!.authority_witness;
    expect(proof.filter(row => row.table === 'recipient_group').map(row => row.id).sort()).toEqual([root, child].sort());
    // A global group inventory revision can change without changing this proof.
    await f.pool.query(`INSERT INTO access.group_member (id,group_id,agent_subject) VALUES ($1,$2,$3)`, [randomUUID(), other, f.actor]);
    expect((await f.registry.register(intent)).dispatchEligible).toBe(true);
    await f.registry.claim(saved.id, saved.requestDigest);
    await f.pool.query('UPDATE access.recipient_group SET parent_id = $2 WHERE id = $1', [child, other]);
    await expect(f.registry.claim(saved.id, saved.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    await f.pool.query('UPDATE access.recipient_group SET parent_id = $2 WHERE id = $1', [child, root]);
    // Restoring the same topology does not restore the old generation.
    expect((await f.registry.register(intent)).dispatchEligible).toBe(false);
    await expect(f.registry.claim(saved.id, saved.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    expect(await f.epoch()).toBe('0');
    await f.cancelled(saved);
  } finally { await f.close(); }
}, 30_000);

test('Generic admissions retain exact mandate and grant generations through claim and retry without a global epoch bump', async () => {
  const f = await fixture();
  try {
    const editScope = `work:edit:${native()}`, grantId = randomUUID(), representationId = randomUUID();
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [editScope]);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.title.apply',clock_timestamp() + interval '1 hour')`, [representationId, f.principalId, f.actor]);
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.title.apply',clock_timestamp() + interval '1 hour')`, [grantId, f.actor, editScope]);
    const request = { ...f.request(), scope: editScope, action: 'work.title.apply' };
    const saved = await f.registry.register(request);
    await f.pool.query('UPDATE access.representation SET active = false WHERE id = $1', [representationId]);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.title.apply',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.principalId, f.actor]);
    await expect(f.registry.claim(saved.id, saved.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await f.registry.register(request)).dispatchEligible).toBe(false);
    const fresh = await f.registry.register({ ...request, idempotencyKey: randomUUID() });
    await f.pool.query('UPDATE access.permission_grant SET valid_until = valid_until + interval \'1 second\' WHERE id = $1', [grantId]);
    await expect(f.registry.claim(fresh.id, fresh.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    expect(await f.epoch()).toBe('0');
  } finally { await f.close(); }
}, 30_000);

test('Concurrent raw controller departures preserve one Agent continuity without fencing unrelated Work admissions', async () => {
  const f = await fixture();
  try {
    const agent = native(), a = randomUUID(), b = randomUUID();
    await f.pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [agent]);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$3,$4,'agent.control','infinity'::timestamptz),
        ($2,$3,$4,'agent.control','infinity'::timestamptz)`, [a,b,f.principalId,agent]);
    const results = await Promise.allSettled([a,b].map(id => f.pool.query('UPDATE access.representation SET active = false WHERE id = $1', [id])));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(row => row.status === 'rejected')).toHaveLength(1);
    expect((await f.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM access.representation
      WHERE subject_id = $1 AND action = 'agent.control' AND active`, [agent])).rows[0]!.n).toBe(1);
    const ordinary = await within(f.registry.register(f.request()));
    await within(f.registry.claim(ordinary.id, ordinary.requestDigest));
    expect(await f.epoch()).toBe('0');
    await within(f.cancelled(ordinary));
  } finally { await f.close(); }
}, 30_000);

test('Realm participation pins the membership episode even when the command grant is independent of membership', async () => {
  const f = await fixture();
  try {
    const { member, join } = await joiningFixture(f);
    const owner = memberships(f.pool), joined = await owner.change(join);
    const realmScope = `reply:place:${f.actor}`;
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1),($2)', [realmScope, `governance:realm:${f.actor}`]);
    await f.pool.query('INSERT INTO access.realm_admin_revision (realm) VALUES ($1)', [f.actor]);
    await f.pool.query(`INSERT INTO access.realm_admin_settings (realm,who_may_submit,visibility,review_mode)
      VALUES ($1,'members','private','mandatory')`, [f.actor]);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'reply.place',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.principalId, member]);
    const grantId = randomUUID();
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$3,$4,'reply.place',clock_timestamp() + interval '1 hour')`, [grantId, f.actor, member, realmScope]);
    const request = { ...f.request(), scope: realmScope, action: 'reply.place', actingSubject: member };
    const saved = await f.registry.register(request);
    expect((await f.pool.query<{ authority_witness: unknown[] }>('SELECT authority_witness FROM access.admission WHERE id = $1',
      [saved.id])).rows[0]!.authority_witness).toContainEqual({ table: 'membership', id: joined.membershipId, generation: '1' });
    await owner.change({ ...join, action: 'leave', expectedGeneration: '1', idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) });
    // The grant survives, and a more permissive policy supplies no replacement
    // for the membership episode that this admission actually used.
    expect((await f.pool.query('SELECT active FROM access.permission_grant WHERE id = $1', [grantId])).rows[0].active).toBe(true);
    await f.pool.query("UPDATE access.realm_admin_settings SET visibility = 'public',who_may_submit = 'granted' WHERE realm = $1", [f.actor]);
    await expect(f.registry.claim(saved.id, saved.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    expect((await f.registry.register(request)).dispatchEligible).toBe(false);
    expect((await f.registry.register({ ...request, idempotencyKey: randomUUID() })).dispatchEligible).toBe(true);
    expect(await f.epoch()).toBe('0');
  } finally { await f.close(); }
}, 30_000);

test('Realm member administration revokes the member proof without invalidating another Reviewer in the same Realm', async () => {
  const f = await fixture();
  const client = await f.pool.connect();
  try {
    const { member, join } = await joiningFixture(f);
    const joined = await memberships(f.pool).change(join);
    const reviewScope = `review:decide:${f.actor}`;
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [reviewScope]);
    for (const actor of [member, f.actor]) {
      await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,'review.decide',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.principalId, actor]);
      await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until,membership_id,membership_generation)
        VALUES ($1,$2,$3,$4,'review.decide',clock_timestamp() + interval '1 hour',$5,$6)`,
      [randomUUID(), f.actor, actor, reviewScope, actor === member ? joined.membershipId : null, actor === member ? '1' : null]);
    }
    const request = { ...f.request(), action: 'review.decide', scope: reviewScope };
    const independent = await f.registry.register(request);
    const dependent = await f.registry.register({ ...request, actingSubject: member, idempotencyKey: randomUUID() });
    await client.query('BEGIN');
    await changeRealmMember(client, f.actor, { actingSubject: f.actor, member, expectedGeneration: '0',
      expectedMembershipGeneration: '1', action: 'remove', reason: 'End membership', consent: null, durationSeconds: null },
    f.principalId, randomUUID());
    await client.query('COMMIT');
    await expect(f.registry.claim(dependent.id, dependent.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    await within(f.registry.claim(independent.id, independent.requestDigest));
    await within(f.cancelled(independent));
    expect((await f.pool.query('SELECT authority_epoch FROM access.scope_gate WHERE id = $1', [reviewScope])).rows[0].authority_epoch).toBe('0');
  } finally { await client.query('ROLLBACK'); client.release(); await f.close(); }
}, 30_000);

test('Policy member-set references share the scope fence and do not invalidate admissions that used no set', async () => {
  const f = await fixture(), client = await f.pool.connect();
  try {
    await f.pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('realm',$1,1,'terms')`, [f.actor]);
    await client.query('BEGIN');
    const ordinary = await f.registry.register(f.request(), client);
    const policy = new AccessPolicyChanges(f.pool), setAdmissionId = randomUUID();
    const context = { principal: f.principal, issuerSubject: f.actor, expectedAuthorityEpoch: '0',
      idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) };
    expect((await within(policy.change(context, { action: 'admit-set', setAdmissionId, setKind: 'realm',
      basis: 'acting_subject', purpose: 'resource-eligibility', referencingScopeId: scope,
      validUntil: new Date(Date.now() + 60_000) }))).authorityEpoch).toBe('0');
    expect((await within(policy.change({ ...context, idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) },
      { action: 'revoke-set', setAdmissionId, expectedGeneration: '0' }))).authorityEpoch).toBe('0');
    await client.query('COMMIT');
    await within(f.registry.claim(ordinary.id, ordinary.requestDigest));
    await within(f.cancelled(ordinary));
    expect(await f.epoch()).toBe('0');
  } finally { await client.query('ROLLBACK'); client.release(); await f.close(); }
}, 30_000);

test('Strong revocation drains exact generic authority witnesses and acknowledges their terminal receipts', async () => {
  const f = await fixture();
  try {
    const editScope = `work:edit:${native()}`, grantId = randomUUID();
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [editScope]);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'work.title.apply',clock_timestamp() + interval '1 hour')`, [randomUUID(), f.principalId, f.actor]);
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,'work.title.apply',clock_timestamp() + interval '1 hour')`, [grantId, f.actor, editScope]);
    const request = { ...f.request(), scope: editScope, action: 'work.title.apply' };
    const claimed = await f.registry.register(request), waiting = await f.registry.register({ ...request, idempotencyKey: randomUUID() });
    await f.registry.claim(claimed.id, claimed.requestDigest);
    const independent = await f.registry.register(f.request());
    const revocations = new AccessRevocations(f.pool);
    const revoked = await revocations.revoke(f.principal, { revocationId: randomUUID(), issuerSubject: f.actor,
      scopeId: editScope, expectedAuthorityEpoch: '0', mode: 'strong',
      target: { kind: 'permission_grant', id: grantId, expectedGeneration: '0' } },
    { idempotencyKey: randomUUID(), requestDigest: 'c'.repeat(64) });
    expect(revoked).toMatchObject({ state: 'draining', affectedWork: 2, pending: 2, fenceAuthorityEpoch: '0' });
    await expect(f.registry.claim(waiting.id, waiting.requestDigest)).rejects.toBeInstanceOf(AdmissionDenied);
    await f.registry.claim(independent.id, independent.requestDigest);
    await f.cancelled(claimed); await f.cancelled(waiting);
    expect(await revocations.read(f.principal, f.actor, revoked.revocationId)).toMatchObject({ state: 'completed', pending: 0 });
    await f.cancelled(independent);
    expect(await f.epoch()).toBe('0');
  } finally { await f.close(); }
}, 30_000);

test('A strong source cut keeps its pending admissions stable while terminal acknowledgement waits', async () => {
  const f = await fixture(), writer = new Pool({ connectionString: f.url, max: 1 });
  const cut = barrier(), release = barrier();
  const pending: Promise<unknown>[] = [];
  writer.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (sql.includes('FROM access.admission') && sql.includes('authority_witness @>')) {
        cut.release(); await release.promise;
      }
      return result;
    }) as typeof client.query;
  });
  try {
    const row = await f.registry.register(f.request());
    await f.registry.claim(row.id, row.requestDigest);
    const grantId = f.workCreateGrant;
    const revocations = new AccessRevocations(writer);
    const changing = revocations.revoke(f.principal, { revocationId: randomUUID(), issuerSubject: f.actor,
      scopeId: scope, expectedAuthorityEpoch: '0', mode: 'strong',
      target: { kind: 'permission_grant', id: grantId, expectedGeneration: '0' } },
    { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    pending.push(changing); await within(cut.promise);
    let acknowledged = false;
    const sealing = f.cancelled(row).then(() => { acknowledged = true; });
    pending.push(sealing); await Bun.sleep(50);
    expect(acknowledged).toBe(false);
    release.release();
    const revoked = await within(changing);
    expect(revoked).toMatchObject({ state: 'draining', pending: 1 });
    await within(sealing);
    expect(await revocations.read(f.principal, f.actor, revoked.revocationId)).toMatchObject({ state: 'completed', pending: 0 });
  } finally { release.release(); await Promise.allSettled(pending); await writer.end(); await f.close(); }
}, 30_000);

test('Claim takes selected sources before its admission row so concurrent strong revocation cannot deadlock the claim', async () => {
  const f = await fixture(), claimant = new Pool({ connectionString: f.url, max: 1 });
  const writer = new Pool({ connectionString: f.url, max: 1 });
  const rowLocked = barrier(), release = barrier();
  const pending: Promise<unknown>[] = [];
  claimant.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (sql.includes('FROM access.admission WHERE id = $1 FOR UPDATE')) {
        rowLocked.release(); await release.promise;
      }
      return result;
    }) as typeof client.query;
  });
  try {
    const row = await f.registry.register(f.request());
    const grantId = f.workCreateGrant;
    const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const claiming = new AccessAdmissionRegistry(claimant).claim(row.id, row.requestDigest);
    pending.push(claiming); await within(rowLocked.promise);
    const changing = new AccessRevocations(writer).revoke(f.principal, { revocationId: randomUUID(), issuerSubject: f.actor,
      scopeId: scope, expectedAuthorityEpoch: '0', mode: 'strong',
      target: { kind: 'permission_grant', id: grantId, expectedGeneration: '0' } },
    { idempotencyKey: randomUUID(), requestDigest: 'b'.repeat(64) });
    pending.push(changing); await waitsOnLock(f.pool, pid);
    release.release();
    expect((await within(claiming)).state).toBe('claimed');
    expect(await within(changing)).toMatchObject({ state: 'draining', affectedWork: 1 });
    await f.cancelled(row);
  } finally { release.release(); await Promise.allSettled(pending); await claimant.end(); await writer.end(); await f.close(); }
}, 30_000);
