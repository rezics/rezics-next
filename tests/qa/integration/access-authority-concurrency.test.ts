import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { AccessInvitations } from '../../../services/main/src/modules/access/invitation.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessRevocations } from '../../../services/main/src/modules/access/revocation-requests.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function waitsOnLock(pool: Pool, pid: number) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if ((await pool.query<{ waiting: boolean }>(
      "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error('Concurrent creator did not wait for its authority key');
}
async function fixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const pool = new Pool({ connectionString: databases.urls.access });
  const actor = native(), recipient = native(), principalId = randomUUID();
  const principal = { issuer: 'https://authority-concurrency.test', subject: randomUUID() };
  await pool.query(`INSERT INTO access.principal (id,account_issuer,account_subject) VALUES ($1,$2,$3)`,
    [principalId, principal.issuer, principal.subject]);
  await pool.query(`INSERT INTO access.authority_subject (id,kind) VALUES ($1,'agent'),($2,'agent')`, [actor, recipient]);
  await pool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
  const mandate = async (subject: string, action: string) => {
    const id = randomUUID();
    await pool.query(`INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
      VALUES ($1,$2,$3,$4,CASE WHEN $4 = 'agent.control' THEN 'infinity'::timestamptz ELSE clock_timestamp() + interval '1 hour' END)`, [id, principalId, subject, action]);
    return id;
  };
  const grant = async (scope: string, action: string, id = randomUUID()) => {
    await pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [id, actor, scope, action]);
    return id;
  };
  return { pool, actor, recipient, principal, principalId, mandate, grant, url: databases.urls.access,
    close: async () => { await pool.end(); await databases.close(); } };
}
function heldLineage(url: string) {
  const owner = new Pool({ connectionString: url, max: 1 }), inserted = barrier(), release = barrier();
  // Wrap promise-based transaction queries without replacing pg's callback API:
  // invitations also use Pool.query for their initial offer lookup.
  const pool = {
    query: (sql: string, values?: unknown[]) => owner.query(sql, values),
    connect: async () => {
      const client = await owner.connect();
      return {
        query: async (sql: string, values?: unknown[]) => {
          const result = await client.query(sql, values);
          if (sql.includes('INSERT INTO access.grant_lineage')) { inserted.release(); await release.promise; }
          return result;
        },
        release: () => client.release(),
      };
    },
    end: () => owner.end(),
  } as unknown as Pool;
  return { pool, inserted, release };
}

/** Copy one accepted issuance template to reach the cap without replaying 255
 * network/API requests. All owner triggers run; only receipts are unnecessary. */
async function seedLineages(pool: Pool, template: string, count: number, dependent: boolean) {
  const ids = Array.from({ length: count }, () => randomUUID());
  await pool.query(`INSERT INTO access.permission_grant
    (id,issuer_subject,recipient_subject,scope_id,action,valid_until,assigned_by_principal)
    SELECT seed.id,g.issuer_subject,g.recipient_subject,g.scope_id,g.action,g.valid_until,g.assigned_by_principal
    FROM unnest($2::uuid[]) seed(id) CROSS JOIN access.permission_grant g WHERE g.id = $1`, [template, ids]);
  await pool.query(`INSERT INTO access.grant_lineage
    (grant_id,issuer_subject,recipient_subject,scope_id,action,lifetime,assigned_by_principal,
      issuer_representation_id,issuer_representation_generation,issuer_representation_action,
      ceiling_grant_id,ceiling_grant_generation,ceiling_scope_id,ceiling_action,
      upstream_grant_id,upstream_generation,root_grant_id,depth,redelegation_depth,invitation_id)
    SELECT seed.id,l.issuer_subject,l.recipient_subject,l.scope_id,l.action,l.lifetime,l.assigned_by_principal,
      l.issuer_representation_id,l.issuer_representation_generation,l.issuer_representation_action,
      l.ceiling_grant_id,l.ceiling_grant_generation,l.ceiling_scope_id,l.ceiling_action,
      l.upstream_grant_id,l.upstream_generation,CASE WHEN $3 THEN l.root_grant_id ELSE seed.id END,
      l.depth,l.redelegation_depth,l.invitation_id
    FROM unnest($2::uuid[]) seed(id) CROSS JOIN access.grant_lineage l WHERE l.grant_id = $1`, [template, ids, dependent]);
}

test('Concurrent delegations at 255 descendants admit exactly one and leave other lineage roots writable', async () => {
  const f = await fixture(), held = heldLineage(f.url), second = new Pool({ connectionString: f.url, max: 1 });
  const pending: Promise<unknown>[] = [];
  try {
    const scope = 'work:create:root', assign = 'access.grant.assign.work.create';
    await f.mandate(f.actor, assign); await f.grant(scope, assign);
    const context = { principal: f.principal, issuerSubject: f.actor, expectedAuthorityEpoch: '0' };
    const until = new Date(Date.now() + 60_000), owner = new AccessGrants(f.pool), root = randomUUID(), other = randomUUID();
    for (const id of [root, other]) await owner.createDelegated(context, id, f.actor, until, receipt(),
      { lifetime: 'institutional', redelegationDepth: 1 });
    const template = randomUUID();
    const lineage = { lifetime: 'dependent' as const, upstreamGrantId: root, redelegationDepth: 0 };
    await owner.createDelegated(context, template, f.recipient, until, receipt(), lineage);
    await seedLineages(f.pool, template, 254, true);
    const firstId = randomUUID(), secondId = randomUUID();
    const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const first = new AccessGrants(held.pool).createDelegated(context, firstId, f.recipient, until, receipt(), lineage);
    pending.push(first); await Promise.race([held.inserted.promise, first]);
    const next = new AccessGrants(second).createDelegated(context, secondId, f.recipient, until, receipt(), lineage);
    pending.push(next); await waitsOnLock(f.pool, pid);
    await owner.createDelegated(context, randomUUID(), f.recipient, until, receipt(), { ...lineage, upstreamGrantId: other });
    held.release.release();
    const results = await Promise.allSettled([first, next]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: '54000' } });
    expect((await f.pool.query(`SELECT count(*)::int AS n FROM access.grant_lineage l
      JOIN access.permission_grant g ON g.id = l.grant_id WHERE l.root_grant_id = $1 AND l.lifetime = 'dependent' AND g.active`,
    [root])).rows[0].n).toBe(256);
    expect((await f.pool.query('SELECT id FROM access.permission_grant WHERE id = $1', [secondId])).rowCount).toBe(0);
  } finally { held.release.release(); await Promise.allSettled(pending); await held.pool.end(); await second.end(); await f.close(); }
}, 30_000);

test('Concurrent management invitation acceptances at one ceiling admit exactly one grant', async () => {
  const f = await fixture(), held = heldLineage(f.url), second = new Pool({ connectionString: f.url, max: 1 });
  const pending: Promise<unknown>[] = [];
  try {
    const scope = `content:draft:${f.actor}`, action = 'content.draft';
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    const issuerController = await f.mandate(f.actor, 'agent.control');
    const controller = await f.mandate(f.recipient, 'agent.control');
    await f.pool.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
      agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
      VALUES ($1::uuid,$2,$1::uuid::text,$3,$4,'person','Recipient',0,'active','fixture',1,$5)`,
    [randomUUID(), f.principalId, 'a'.repeat(64), f.recipient, controller]);
    await f.pool.query(`INSERT INTO access.agent_provision (id,principal_id,idempotency_key,request_digest,
      agent_id,agent_kind,display_name,principal_epoch,state,graph_data_epoch,graph_sequence,representation_id)
      VALUES ($1::uuid,$2,$1::uuid::text,$3,$4,'person','Issuer',0,'active','fixture',1,$5)`,
    [randomUUID(), f.principalId, 'a'.repeat(64), f.actor, issuerController]);
    const ceiling = await f.grant(scope, action), invitations = new AccessInvitations(f.pool);
    const issue = async () => {
      const id = randomUUID();
      await invitations.issue(f.principal, receipt(), { invitationId: id, issuerSubject: f.actor,
        recipientSubject: f.recipient, scopeId: scope, actions: [action], offer: 'manage', issuerLifetime: 'institutional',
        expectedAuthorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000), grantValidUntil: new Date(Date.now() + 120_000) });
      return id;
    };
    const template = randomUUID();
    await invitations.accept(f.principal, receipt(), { invitationId: await issue(), grantId: template, expectedAuthorityEpoch: '0' });
    await seedLineages(f.pool, template, 254, false);
    const a = await issue(), b = await issue(), secondId = randomUUID();
    const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const first = new AccessInvitations(held.pool).accept(f.principal, receipt(),
      { invitationId: a, grantId: randomUUID(), expectedAuthorityEpoch: '0' });
    pending.push(first); await Promise.race([held.inserted.promise, first]);
    const next = new AccessInvitations(second).accept(f.principal, receipt(),
      { invitationId: b, grantId: secondId, expectedAuthorityEpoch: '0' });
    pending.push(next); await waitsOnLock(f.pool, pid);
    // A different Agent's draft ceiling remains independently writable.
    const independentScope = `content:draft:${f.recipient}`, independentInvitation = randomUUID();
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [independentScope]);
    await f.pool.query(`INSERT INTO access.permission_grant (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,$3,$4,clock_timestamp() + interval '1 hour')`, [randomUUID(), f.recipient, independentScope, action]);
    await invitations.issue(f.principal, receipt(), { invitationId: independentInvitation, issuerSubject: f.recipient,
      recipientSubject: f.actor, scopeId: independentScope, actions: [action], offer: 'manage', issuerLifetime: 'institutional',
      expectedAuthorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000), grantValidUntil: new Date(Date.now() + 120_000) });
    await invitations.accept(f.principal, receipt(),
      { invitationId: independentInvitation, grantId: randomUUID(), expectedAuthorityEpoch: '0' });
    held.release.release();
    const results = await Promise.allSettled([first, next]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { message: 'invitation management ceiling fan-out limit' } });
    expect((await f.pool.query(`SELECT count(*)::int AS n FROM access.grant_lineage l
      JOIN access.permission_grant g ON g.id = l.grant_id WHERE l.ceiling_grant_id = $1 AND g.active`, [ceiling])).rows[0].n).toBe(256);
    expect((await f.pool.query('SELECT id FROM access.permission_grant WHERE id = $1', [secondId])).rowCount).toBe(0);
  } finally { held.release.release(); await Promise.allSettled(pending); await held.pool.end(); await second.end(); await f.close(); }
}, 30_000);

test('Catalogue replay waits on its saved grant before locking admissions during a strong revocation', async () => {
  const f = await fixture(), writer = new Pool({ connectionString: f.url, max: 1 });
  const replayPool = new Pool({ connectionString: f.url, max: 1 }), cut = barrier(), release = barrier();
  const pending: Promise<unknown>[] = [];
  writer.on('connect', client => {
    const query = client.query.bind(client);
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (/UPDATE\s+access\.permission_grant/.test(sql)) { cut.release(); await release.promise; }
      return result;
    }) as typeof client.query;
  });
  try {
    const scope = 'work:create:catalogue-import';
    await f.pool.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
    await f.mandate(f.actor, 'work.create'); await f.mandate(f.actor, 'access.revoke');
    await f.grant(scope, 'access.revoke');
    const savedGrant = await f.grant(scope, 'work.create', 'ffffffff-ffff-4fff-8fff-ffffffffffff');
    const registry = new AccessAdmissionRegistry(f.pool), items = [{ key: randomUUID(), digest: 'a'.repeat(64) }];
    const original = (await registry.admitCatalogue(f.principal, f.actor, items))[0]!;
    if (!('admission' in original)) throw new Error('Catalogue setup was denied');
    await f.grant(scope, 'work.create', '00000000-0000-4000-8000-000000000001');
    const changing = new AccessRevocations(writer).revoke(f.principal, { revocationId: randomUUID(),
      issuerSubject: f.actor, scopeId: scope, expectedAuthorityEpoch: '0', mode: 'strong',
      target: { kind: 'permission_grant', id: savedGrant, expectedGeneration: '0' } }, receipt());
    pending.push(changing); await Promise.race([cut.promise, changing]);
    const pid = (await replayPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const retry = new AccessAdmissionRegistry(replayPool).admitCatalogue(f.principal, f.actor, items);
    pending.push(retry); await waitsOnLock(f.pool, pid);
    const probe = await f.pool.connect();
    try {
      await probe.query('BEGIN');
      await probe.query('SELECT 1 FROM access.admission WHERE id = $1 FOR UPDATE NOWAIT', [original.admission.id]);
    } finally { await probe.query('ROLLBACK'); probe.release(); }
    release.release();
    expect(await changing).toMatchObject({ state: 'draining', affectedWork: 1 });
    expect((await retry)[0]).toMatchObject({ admission: { id: original.admission.id, replayed: true, dispatchEligible: false } });
    expect((await registry.admitCatalogue(f.principal, f.actor, [{ ...items[0]!, key: randomUUID() }]))[0])
      .toMatchObject({ admission: { dispatchEligible: true } });
  } finally { release.release(); await Promise.allSettled(pending); await writer.end(); await replayPool.end(); await f.close(); }
}, 30_000);
