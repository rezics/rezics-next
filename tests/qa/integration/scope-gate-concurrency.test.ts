import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { AccessAdmissionRegistry, AdmissionConflict, AdmissionDenied, AdmissionUnavailable,
  engageAccessRecoveryFence, releaseAccessRecoveryFence,
  type AdmissionRequest, type RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { AccessMembershipConsents } from '../../../services/main/src/modules/access/membership-consents.ts';
import { AccessMemberships, type MembershipChange } from '../../../services/main/src/modules/access/memberships.ts';
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
  try {
    await pool.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)`,
      [principalId, principal.issuer, principal.subject]);
    await pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [actor]);
    await pool.query(`INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING`, [scope]);
    for (const action of ['work.create', 'access.grant.assign.work.create', 'access.membership.consent',
      'access.membership.manage.realm', 'access.role.manage']) {
      await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
      await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    }
  } catch (error) { await pool.end(); await databases.close(); throw error; }
  const registry = new AccessAdmissionRegistry(pool);
  const request = (key = randomUUID()): AdmissionRequest => ({ principal, actingSubject: actor, scope,
    action: 'work.create', idempotencyKey: key, requestDigest: 'a'.repeat(64) });
  const epoch = async () => (await pool.query<{ authority_epoch: string }>(
    'SELECT authority_epoch::text FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!.authority_epoch;
  const cancelled = (row: RegisteredAdmission) => registry.recordGraphOutcome(row.id, {
    admissionId: row.id, scope, requestDigest: row.requestDigest, authorityEpoch: row.authorityEpoch,
    receipt: `urn:rezics:receipt:${createHash('sha256').update(`${row.id}\0create-metadata-work`).digest('hex')}`,
    outcome: 'cancelled', dataEpoch: 'scope-gate-fixture', sequence: '1',
  });
  return { pool, url: databases.urls.access, registry, actor, principal, principalId, request, epoch, cancelled,
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

test('Consent issuance and role revisions share unchanged authority with ordinary admissions', async () => {
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
    const roles = new AccessRoles(f.pool), family = randomUUID();
    const roleIntent = { principal: f.principal, issuerSubject: f.actor, expectedAuthorityEpoch: await f.epoch(),
      idempotencyKey: randomUUID(), requestDigest: 'd'.repeat(64) };
    expect(await within(Promise.all([roles.createFamily(roleIntent, family, []),
      roles.createFamily(roleIntent, family, [])]))).toEqual(['1', '1']);
    await held.query('COMMIT');
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

test('Realm joins and grant creation retain their exclusive global epoch fence', async () => {
  const f = await fixture();
  const heldPool = new Pool({ connectionString: f.url, max: 1 });
  const gateRead = barrier(), release = barrier();
  const pending: Promise<unknown>[] = [];
  try {
    const member = native();
    await f.pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent')`, [member]);
    await f.pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,'access.membership.consent',clock_timestamp() + interval '1 hour')`,
    [randomUUID(), f.principalId, member]);
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$3,$4,'access.membership.consent',clock_timestamp() + interval '1 hour')`,
    [randomUUID(), f.actor, member, scope]);
    await f.pool.query(`INSERT INTO access.membership_policy (kind,owner_subject,revision,terms_revision)
      VALUES ('realm',$1,1,'terms')`, [f.actor]);
    const consent = await new AccessMembershipConsents(f.pool).issue({ principal: f.principal, kind: 'realm',
      ownerSubject: f.actor, memberSubject: member, expectedGeneration: '0', expectedPolicyRevision: '1',
      termsRevision: 'terms', idempotencyKey: randomUUID(), requestDigest: 'e'.repeat(64) });
    heldPool.on('connect', client => {
      const query = client.query.bind(client);
      let pause = true;
      client.query = (async (sql: string, values?: unknown[]) => {
        const result = await query(sql, values);
        if (pause && sql.includes('FROM access.scope_gate') && values?.[0] === scope) {
          pause = false; gateRead.release(); await release.promise;
        }
        return result;
      }) as typeof client.query;
    });
    const join: MembershipChange = { principal: f.principal, kind: 'realm', ownerSubject: f.actor,
      memberSubject: member, action: 'join', expectedGeneration: '0', expectedPolicyRevision: '1',
      termsRevision: 'terms', consentReference: consent.consentReference, idempotencyKey: randomUUID(), requestDigest: 'f'.repeat(64) };
    const memberships = new AccessMemberships(heldPool);
    memberships.configureFollowGraph(new FusekiClient(Bun.env.FUSEKI_URL!));
    const joining = memberships.change(join);
    pending.push(joining);
    await within(gateRead.promise);
    const probe = await f.pool.connect();
    try {
      await probe.query('BEGIN');
      await expect(probe.query('SELECT 1 FROM access.scope_gate WHERE id = $1 FOR SHARE NOWAIT', [scope])).rejects.toMatchObject({ code: '55P03' });
    } finally { await probe.query('ROLLBACK'); probe.release(); }
    release.release();
    const joined = await within(joining);
    expect(joined.generation).toBe('1');
    expect(joined.authorityEpoch).toBe('1');
    const held = await f.pool.connect();
    try {
      await held.query('BEGIN');
      await f.registry.register(f.request(), held);
      const writer = new Pool({ connectionString: f.url, max: 1 });
      try {
        const pid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
        const grant = new AccessGrants(writer).create({ principal: f.principal, issuerSubject: f.actor,
          expectedAuthorityEpoch: joined.authorityEpoch }, randomUUID(), member, new Date(Date.now() + 60_000),
        { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
        pending.push(grant);
        await waitsOnLock(f.pool, pid);
        await held.query('COMMIT');
        expect(await within(grant)).toBe('2');
      } finally { await held.query('ROLLBACK'); await Promise.allSettled(pending); await writer.end(); }
    } finally { held.release(); }
  } finally {
    release.release(); await Promise.allSettled(pending);
    await heldPool.end(); await f.close();
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
