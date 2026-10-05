import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { governanceBodyScopeId, proposalAccessTables,
  proposalExecutionAction } from '../../../services/main/src/modules/proposal/schema.ts';
import { pollScopeId, voteAccessTables, voteOperationAction,
  votingMandateAction } from '../../../services/main/src/modules/vote/schema.ts';

// Owner-schema migration proof for Access 070-073: an empty install and an
// upgrade from the pre-vote head with retained legacy state reach the same
// DDL, and the private vote/proposal state rejects inconsistent writes.
const root = resolve(import.meta.dir, '../../..');
const migrationDir = join(root, 'services/main/migrations/access');
const migrations = schemaFiles(root, 'access');
const beforeVote = migrations.filter(file => migrationVersion(file) < 70);
const fromVote = migrations.filter(file => migrationVersion(file) >= 70);
const id = () => `https://rezics.com/id/${randomUUID()}`;
const hex = (value: string) => createHash('sha256').update(value).digest('hex');

async function migrate(db: Client, files: readonly string[]): Promise<void> {
  for (const file of files) await db.query(readFileSync(join(migrationDir, file), 'utf8'));
}

async function rejects(run: Promise<unknown>, code: string): Promise<void> {
  const error = await run.then(() => undefined, (failure: unknown) => failure as { code?: string });
  expect(error?.code).toBe(code);
}

/** One statement group that must fail at COMMIT, leaving the connection usable. */
async function rejectsAtCommit(db: Client, code: string, statements: () => Promise<void>): Promise<void> {
  await db.query('BEGIN');
  try {
    await statements();
    await rejects(db.query('COMMIT'), code);
  } finally { await db.query('ROLLBACK').catch(() => undefined); }
}

async function withScratchDatabases(names: readonly string[],
  run: (urls: Record<string, string>) => Promise<void>): Promise<void> {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const compose = readEnv(join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'compose.env'));
  const adminUrl = `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`;
  const suffix = randomBytes(6).toString('hex');
  const created: string[] = [];
  const urls: Record<string, string> = {};
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const name of names) {
      const database = `qa_${suffix}_${name}`;
      await admin.query(`CREATE DATABASE ${database} OWNER access`);
      created.push(database);
      const url = new URL(Bun.env.ACCESS_DATABASE_URL);
      url.pathname = `/${database}`;
      urls[name] = url.toString();
    }
    await run(urls);
  } finally {
    for (const database of created.reverse()) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
}

async function columns(db: Client, table: string): Promise<string[]> {
  return (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'access' AND table_name = $1 ORDER BY column_name`, [table])).rows
    .map(row => row.column_name);
}

async function expectTypedDeclarations(db: Client): Promise<void> {
  for (const [table, declared] of Object.entries({ ...voteAccessTables, ...proposalAccessTables })) {
    expect(await columns(db, table)).toEqual(Object.keys(declared).sort());
  }
}

/** Exact rejected and accepted states of the private vote/proposal owner. */
async function exerciseVoteOwner(db: Client): Promise<void> {
  const [p, q, admin] = [randomUUID(), randomUUID(), randomUUID()];
  for (const principal of [p, q, admin]) {
    await db.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, 'https://account.rezics.test', $2)`, [principal, `vote-schema-${principal}`]);
  }
  const [holder, otherHolder, body, proxy, administrator] = [id(), id(), id(), id(), id()];
  for (const subject of [holder, otherHolder, body, proxy, administrator]) {
    await db.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [subject]);
  }
  const poll = id();
  const otherPoll = id();
  await db.query('INSERT INTO access.scope_gate (id) VALUES ($1), ($2), ($3), ($4)',
    [pollScopeId(poll), pollScopeId(otherPoll), governanceBodyScopeId(body), 'realm:policy:vote-schema']);

  async function mandate(principal: string, subject: string, action: string, resource: string | null) {
    const representation = randomUUID();
    await db.query(`INSERT INTO access.representation
      (id, principal_id, subject_id, action, valid_until, resource_subject)
      VALUES ($1, $2, $3, $4, now() + interval '1 day', $5)`, [representation, principal, subject, action, resource]);
    return representation;
  }
  // A voting mandate names its electorate body; it never exists without one.
  await rejects(mandate(p, holder, votingMandateAction, null), '23514');
  await rejects(db.query(`INSERT INTO access.representation_request (id, recipient_principal, subject_id,
    action, valid_until, idempotency_key, request_digest, expires_at)
    VALUES ($1, $2, $3, $4, now() + interval '1 day', 'r1', $5, now() + interval '15 minutes')`,
  [randomUUID(), p, holder, votingMandateAction, hex('r1')]), '23514');
  await db.query(`INSERT INTO access.representation_request (id, recipient_principal, subject_id,
    action, valid_until, idempotency_key, request_digest, expires_at, resource_subject)
    VALUES ($1, $2, $3, $4, now() + interval '1 day', 'r2', $5, now() + interval '15 minutes', $6)`,
  [randomUUID(), p, holder, votingMandateAction, hex('r2'), body]);
  const pHolder = await mandate(p, holder, votingMandateAction, body);
  const pHolderAgain = await mandate(p, holder, votingMandateAction, body);
  const qHolder = await mandate(q, holder, votingMandateAction, body);
  const qOther = await mandate(q, otherHolder, votingMandateAction, body);
  const pProxy = await mandate(p, proxy, votingMandateAction, body);
  const pSeat = await mandate(p, holder, 'governance.seat.manage', null);
  const adminPoll = await mandate(admin, administrator, 'governance.poll.administer', null);
  const adminBody = await mandate(admin, body, proposalExecutionAction, null);

  // Replacing a representative is a new mandate identity; an episode only revokes.
  const replaced = await mandate(q, holder, votingMandateAction, body);
  await rejects(db.query(`UPDATE access.representation SET valid_until = valid_until + interval '1 day'
    WHERE id = $1`, [replaced]), '23514');
  await rejects(db.query('UPDATE access.representation SET resource_subject = $2 WHERE id = $1',
    [replaced, proxy]), '23514');
  await db.query('UPDATE access.representation SET active = false WHERE id = $1', [replaced]);
  await rejects(db.query('UPDATE access.representation SET active = true WHERE id = $1', [replaced]), '23514');

  // The protected representative policy selects exact current mandates by principal.
  const policy = randomUUID();
  const charter = id();
  await db.query('BEGIN');
  await db.query(`INSERT INTO access.vote_representative_policy (id, holder_subject, body_subject, head_revision)
    VALUES ($1, $2, $3, 1)`, [policy, holder, body]);
  await db.query(`INSERT INTO access.vote_representative_policy_revision
    (policy_id, revision, holder_charter_revision, holder_charter_digest, authority_epoch)
    VALUES ($1, 1, $2, $3, 0)`, [policy, charter, hex(charter)]);
  const member = (role: string, representation: string, principal: string, generation = 0) =>
    db.query(`INSERT INTO access.vote_representative_policy_member
      (policy_id, revision, role, representation_id, representation_generation, principal_id)
      VALUES ($1, 1, $2, $3, $4, $5)`, [policy, role, representation, generation, principal]);
  await member('designated', pHolder, p);
  await member('approver', pHolder, p);
  await member('approver', qHolder, q);
  await db.query('COMMIT');
  await rejects(member('backup', qHolder, q, 1), '23514');
  await rejects(member('backup', qOther, q), '23514');
  await rejects(member('backup', replaced, q, 1), '23514');
  await rejects(member('designated', qHolder, q), '23505');
  // Two mandates of one principal are one control identity, never two approvers.
  await rejects(member('approver', pHolderAgain, p), '23505');
  await rejects(db.query(`UPDATE access.vote_representative_policy_revision SET authority_epoch = 1
    WHERE policy_id = $1`, [policy]), '23514');
  await rejects(db.query('DELETE FROM access.vote_representative_policy_member WHERE policy_id = $1',
    [policy]), '23514');
  await rejectsAtCommit(db, '23503', async () => {
    await db.query('UPDATE access.vote_representative_policy SET head_revision = 2 WHERE id = $1', [policy]);
  });
  await db.query(`INSERT INTO access.vote_representative_policy_revision
    (policy_id, revision, holder_charter_revision, holder_charter_digest, authority_epoch)
    VALUES ($1, 2, $2, $3, 1), ($1, 3, $2, $3, 2)`, [policy, charter, hex(charter)]);
  await rejects(db.query('UPDATE access.vote_representative_policy SET head_revision = 3 WHERE id = $1',
    [policy]), '23514');
  await db.query('UPDATE access.vote_representative_policy SET head_revision = 2 WHERE id = $1', [policy]);

  // Every governance vote admission commits with one exact private proof.
  let key = 0;
  async function admission(principal: string, acting: string, scope: string, action: string) {
    const admissionId = randomUUID();
    await db.query(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
      idempotency_key, request_digest, authority_epoch, expires_at, state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0, now() + interval '1 minute', 'registered')`,
    [admissionId, principal, acting, scope, action, `vote-${++key}`, hex(String(key))]);
    return admissionId;
  }
  const seat = id();
  const entitlement = id();
  type Proof = { operation: keyof typeof voteOperationAction; path: string; representation: string;
    holder?: string | null; proxy?: string | null; seat?: string | null; entitlement?: string | null;
    grant?: string | null; policy?: string | null; poll?: string };
  const proof = (admissionId: string, value: Proof) => db.query(`INSERT INTO access.vote_admission
    (admission_id, operation, poll, body_subject, holder_subject, proxy_subject, seat, source_entitlement,
      authority_path, representation_id, representation_generation, grant_id, grant_generation,
      policy_id, policy_revision, principal_epoch, acting_subject_generation, candidate_digest, expected_head)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, CASE WHEN $11::uuid IS NULL THEN NULL ELSE 0 END,
      $12, CASE WHEN $12::uuid IS NULL THEN NULL ELSE 1 END, 0, 0, $13, NULL)`,
  [admissionId, value.operation, value.poll ?? poll, body, value.holder === undefined ? holder : value.holder,
    value.proxy ?? null, value.seat === undefined ? seat : value.seat,
    value.entitlement === undefined ? entitlement : value.entitlement, value.path, value.representation,
    value.grant ?? null, value.policy ?? null, hex(`${admissionId}-candidate`)]);
  const cast: Proof = { operation: 'ballot.cast', path: 'holder-mandate', representation: pHolder };

  await rejectsAtCommit(db, '23514', async () => {
    await admission(p, holder, pollScopeId(poll), 'governance.ballot.operate');
  });
  await db.query('BEGIN');
  await proof(await admission(p, holder, pollScopeId(poll), 'governance.ballot.operate'), cast);
  await db.query('COMMIT');
  await db.query('BEGIN');
  const approval = await admission(q, holder, pollScopeId(poll), 'governance.ballot.operate');
  await proof(approval, { operation: 'ballot.approve', path: 'holder-mandate', representation: qHolder, policy });
  await db.query('COMMIT');
  await rejects(db.query('UPDATE access.vote_admission SET expected_head = NULL WHERE admission_id = $1',
    [approval]), '23514');
  const rejected: [string, string, string, Proof, string][] = [
    // Wrong poll gate, a seat-management action for casting, and another holder's mandate.
    [p, holder, pollScopeId(otherPoll), cast, '23514'],
    [p, holder, pollScopeId(poll), { ...cast, representation: pSeat }, '23514'],
    [q, otherHolder, pollScopeId(poll), { ...cast, representation: qOther }, '23514'],
    // A proxy is one explicit other Agent; approvals always cite the policy revision.
    [p, proxy, pollScopeId(poll), { ...cast, path: 'proxy-mandate', representation: pProxy, proxy: holder }, '23514'],
    [q, holder, pollScopeId(poll), { operation: 'ballot.approve', path: 'holder-mandate',
      representation: qHolder }, '23514'],
    // Poll administration requires the body's grant; casting cannot carry one.
    [admin, administrator, pollScopeId(poll), { operation: 'poll.open', path: 'body-grant',
      representation: adminPoll, holder: null, seat: null, entitlement: null }, '23514'],
  ];
  for (const [principal, acting, scope, value, code] of rejected) {
    await db.query('BEGIN');
    try {
      const admissionId = await admission(principal, acting, scope, voteOperationAction[value.operation]);
      await rejects(proof(admissionId, value), code);
    } finally { await db.query('ROLLBACK'); }
  }
  await db.query('BEGIN');
  await proof(await admission(p, proxy, pollScopeId(poll), 'governance.ballot.operate'),
    { ...cast, path: 'proxy-mandate', representation: pProxy, proxy });
  await proof(await admission(p, holder, pollScopeId(poll), 'governance.seat.manage'),
    { operation: 'allocation.activate', path: 'holder-mandate', representation: pSeat, seat: null });
  await proof(await admission(p, holder, pollScopeId(poll), 'governance.seat.manage'),
    { operation: 'holder-charter.set', path: 'holder-mandate', representation: pSeat, seat: null });
  await db.query('COMMIT');

  const grant = async (issuer: string, recipient: string, scope: string, action: string) => {
    const grantId = randomUUID();
    await db.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id,
      action, valid_until) VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
    [grantId, issuer, recipient, scope, action]);
    return grantId;
  };
  const pollGrant = await grant(body, administrator, pollScopeId(poll), 'governance.poll.administer');
  const foreignGrant = await grant(holder, administrator, pollScopeId(poll), 'governance.poll.administer');
  const open: Proof = { operation: 'poll.open', path: 'body-grant', representation: adminPoll,
    holder: null, seat: null, entitlement: null, grant: pollGrant };
  await db.query('BEGIN');
  try {
    await rejects(proof(await admission(admin, administrator, pollScopeId(poll), 'governance.poll.administer'),
      { ...open, grant: foreignGrant }), '23514');
  } finally { await db.query('ROLLBACK'); }
  await db.query('BEGIN');
  await proof(await admission(admin, administrator, pollScopeId(poll), 'governance.poll.administer'), open);
  await db.query('COMMIT');

  // Execution binds the executor's body mandate and the body's own capability grant.
  const capabilityGrant = await grant(administrator, body, 'realm:policy:vote-schema', 'realm.policy.update');
  const execute = (admissionId: string, capability = 'realm.policy.update') => db.query(`INSERT INTO
    access.proposal_execution_admission (admission_id, proposal, proposal_revision, resolution, body_subject,
      effect_digest, effect_target, expected_target_state, capability, capability_scope, capability_grant_id,
      capability_grant_generation, representation_id, representation_generation, principal_epoch, body_generation)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'realm:policy:vote-schema', $10, 0, $11, 0, 0, 0)`,
  [admissionId, id(), id(), id(), body, hex('effect'), id(), hex('target'), capability, capabilityGrant,
    adminBody]);
  const executionAdmission = () => admission(admin, body, governanceBodyScopeId(body), proposalExecutionAction);
  await rejectsAtCommit(db, '23514', async () => { await executionAdmission(); });
  for (const capability of ['realm.policy.delete', 'governance.ballot.invalidate']) {
    await db.query('BEGIN');
    try { await rejects(execute(await executionAdmission(), capability), '23514'); }
    finally { await db.query('ROLLBACK'); }
  }
  await db.query('BEGIN');
  const executed = await executionAdmission();
  await execute(executed);
  await db.query('COMMIT');
  await rejects(db.query('DELETE FROM access.proposal_execution_admission WHERE admission_id = $1',
    [executed]), '23514');
}

test('vote schema: Access 070-073 install empty and upgrade from the pre-vote head', async () => {
  expect(fromVote.slice(0, 4)).toEqual(['070_vote_representative_policy.sql', '071_vote_admission.sql',
    '072_proposal_execution_admission.sql', '073_vote_holder_charter.sql']);
  await withScratchDatabases(['empty', 'upgrade'], async urls => {
    const empty = new Client({ connectionString: urls.empty });
    const upgrade = new Client({ connectionString: urls.upgrade });
    await empty.connect();
    await upgrade.connect();
    try {
      await migrate(empty, migrations);
      await expectTypedDeclarations(empty);
      await exerciseVoteOwner(empty);

      // Retained pre-vote state: a work.create mandate, request and open admission.
      await migrate(upgrade, beforeVote);
      const principal = randomUUID();
      const agent = id();
      const legacy = randomUUID();
      const admissionId = randomUUID();
      await upgrade.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1, 'https://account.rezics.test', 'legacy')`, [principal]);
      await upgrade.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [agent]);
      await upgrade.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root')`);
      await upgrade.query(`INSERT INTO access.representation_request (id, recipient_principal, subject_id,
        action, valid_until, idempotency_key, request_digest, expires_at)
        VALUES ($1, $2, $3, 'work.create', now() + interval '1 day', 'legacy', $4, now() + interval '15 minutes')`,
      [randomUUID(), principal, agent, hex('legacy-request')]);
      await upgrade.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
        VALUES ($1, $2, $3, 'work.create', now() + interval '1 day')`, [legacy, principal, agent]);
      await upgrade.query(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
        idempotency_key, request_digest, authority_epoch, expires_at, state)
        VALUES ($1, $2, $3, 'work:create:root', 'work.create', 'legacy', $4, 0, now() + interval '1 minute',
          'registered')`, [admissionId, principal, agent, hex('legacy-admission')]);
      const snapshot = async () => (await upgrade.query(`SELECT
        (SELECT count(*) FROM access.representation_request)::int AS requests,
        (SELECT row_to_json(r)::text FROM access.representation r WHERE id = $1) AS mandate,
        (SELECT (to_jsonb(a) - 'authority_witness')::text FROM access.admission a WHERE id = $2) AS admission`,
      [legacy, admissionId])).rows[0];
      const before = await snapshot();
      await migrate(upgrade, fromVote);
      expect(await snapshot()).toEqual(before);
      // Upgrades retain the old command's fields; a new nullable source witness
      // does not manufacture authority for the retained legacy admission.
      expect((await upgrade.query('SELECT authority_witness FROM access.admission WHERE id = $1',
        [admissionId])).rows[0].authority_witness).toBeNull();
      // Non-voting mandates keep their earlier update rules after the upgrade.
      const revoked = await upgrade.query<{ generation: string }>(`UPDATE access.representation SET active = false
        WHERE id = $1 RETURNING generation`, [legacy]);
      expect(revoked.rows[0]?.generation).toBe('1');
      await upgrade.query(`UPDATE access.admission SET state = 'claimed', claimed_at = now() WHERE id = $1`,
        [admissionId]);
      await expectTypedDeclarations(upgrade);
      await exerciseVoteOwner(upgrade);

      const schema = (db: Client) => db.query<{ object: string }>(`
        SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable AS object
          FROM information_schema.columns WHERE table_schema = 'access'
        UNION ALL SELECT 'constraint ' || conrelid::regclass || ' ' || pg_get_constraintdef(oid)
          FROM pg_constraint WHERE connamespace = 'access'::regnamespace
        UNION ALL SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'access'
        UNION ALL SELECT 'trigger ' || tgrelid::regclass || ' ' || tgname FROM pg_trigger
          WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'access.%'
        ORDER BY 1`);
      expect((await schema(upgrade)).rows).toEqual((await schema(empty)).rows);
    } finally {
      await empty.end();
      await upgrade.end();
    }
  });
}, 120_000);
