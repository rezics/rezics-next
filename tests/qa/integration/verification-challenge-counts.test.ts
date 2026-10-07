import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import { VerificationStore, nativeId, uuidOf } from '../../../services/main/src/modules/verification/store.ts';

let pool: Pool;
beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) {
    throw new Error('Run through the isolated integration tier');
  }
  pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 6 });
  await migrateContent(pool);
});
afterAll(async () => { await pool?.end(); });

function fixture(database = pool) {
  const principal = randomUUID();
  const decider = randomUUID();
  const claim = nativeId(randomUUID());
  const store = new VerificationStore(database);
  const input = { claimRevision: nativeId(randomUUID()), adoptedRevision: null,
    context: 'urn:rezics:context:challenge-counts', reason: 'Review the precise claim',
    counterevidence: [], actingSubject: nativeId(principal) };
  return { database, principal, decider, claim, store, input };
}

async function submit(f: ReturnType<typeof fixture>, key = randomUUID()) {
  const result = await f.store.submitChallenge(f.principal, key, f.claim, f.input);
  return uuidOf(result.challenge.challenge)!;
}

async function decide(f: ReturnType<typeof fixture>, challenge: string, key = randomUUID()) {
  await f.store.resolveChallenges(f.decider, key, f.claim, nativeId(randomUUID()),
    [challenge], 'not-established', 'Independent assessment reviewed', nativeId(f.decider));
}

// Large retained histories exercise the actual domain triggers, with receipts
// and decisions committed together, rather than seeding the aggregate directly.
async function history(f: ReturnType<typeof fixture>, count: number, distinctClaims = false) {
  const client = await f.database.connect();
  try {
    await client.query('BEGIN');
    const ids = Array.from({ length: count }, () => randomUUID());
    const claims = ids.map(() => distinctClaims ? nativeId(randomUUID()) : f.claim);
    const submitReceipts = ids.map(() => randomUUID());
    const decisionReceipts = ids.map(() => randomUUID());
    await client.query(`INSERT INTO verification.receipt
      (id, principal_id, action, idempotency_key, request_digest, outcome, result_id)
      SELECT receipt, $3, 'challenge.submit', receipt::text, repeat('a', 64), 'succeeded', challenge
      FROM unnest($1::uuid[], $2::uuid[]) AS input(receipt, challenge)`,
    [submitReceipts, ids, f.principal]);
    await client.query(`INSERT INTO verification.challenge
      (id, claim, claim_revision, context, reason, acting_subject, operation_id, principal_id)
      SELECT challenge, claim, $4, $5, $6, $7, receipt, $8
      FROM unnest($1::uuid[], $2::uuid[], $3::text[]) AS input(challenge, receipt, claim)`,
    [ids, submitReceipts, claims, f.input.claimRevision, f.input.context,
      f.input.reason, f.input.actingSubject, f.principal]);
    await client.query(`INSERT INTO verification.receipt
      (id, principal_id, action, idempotency_key, request_digest, outcome, result_id)
      SELECT receipt, $3, 'challenge.resolve', receipt::text, repeat('b', 64), 'succeeded', challenge
      FROM unnest($1::uuid[], $2::uuid[]) AS input(receipt, challenge)`,
    [decisionReceipts, ids, f.decider]);
    await client.query(`INSERT INTO verification.challenge_resolution
      (challenge_id, outcome, assessment, reason, acting_subject, operation_id, principal_id)
      SELECT challenge, 'not-established', $3, 'Independent assessment reviewed', $4, receipt, $5
      FROM unnest($1::uuid[], $2::uuid[]) AS input(challenge, receipt)`,
    [ids, decisionReceipts, nativeId(randomUUID()), nativeId(f.decider), f.decider]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('challenge counts read one indexed claim head regardless of retained or unrelated history', async () => {
  const f = fixture();
  expect(await f.store.challengeState(f.claim)).toEqual({ revision: null, open: 0, resolved: 0 });
  await submit(f);
  const queries: string[] = [];
  const measured = new VerificationStore({ connect: async () => {
    const client = await pool.connect();
    return { query: (sql: string, values?: unknown[]) => {
      queries.push(sql);
      return client.query(sql, values);
    }, release: () => client.release() };
  } } as unknown as Pool);
  async function read(forceIndex = false) {
    queries.length = 0;
    const state = await measured.challengeState(f.claim);
    const reads = queries.filter(sql => /\bSELECT\b/.test(sql));
    expect(reads).toHaveLength(1);
    const sql = reads[0]!;
    expect(sql).not.toMatch(/challenge_resolution|JOIN|count\s*\(/i);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A tiny isolated database may otherwise choose a seq scan. Require the
      // indexed point-seek and count its returned tuples, independent of timing.
      if (forceIndex) await client.query('SET LOCAL enable_seqscan = off');
      const plan = (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${sql}`,
        [f.claim])).rows[0]['QUERY PLAN'][0].Plan;
      expect(plan['Index Name']).toBe('challenge_head_pkey');
      expect(plan['Actual Rows']).toBe(1);
      expect(plan['Actual Loops']).toBe(1);
      expect(plan.Plans).toBeUndefined();
      await client.query('ROLLBACK');
      return { state, sql, tuples: plan['Actual Rows'] * plan['Actual Loops'] };
    } finally { client.release(); }
  }
  const before = await read(true);
  await history(f, 1_025);
  const unrelated = fixture();
  await history(unrelated, 1_025, true);
  await pool.query('ANALYZE verification.challenge_head');
  const after = await read();
  expect(after.state).toEqual({ revision: '2051', open: 1, resolved: 1_025 });
  expect(after.sql).toBe(before.sql);
  expect(after.tuples).toBe(before.tuples);
}, 90_000);

test('lost acknowledgement and simultaneous admission replay update counts exactly once', async () => {
  const f = fixture();
  const first = await submit(f);
  const second = await submit(f);
  const admission = randomUUID();
  const assessment = nativeId(randomUUID());
  const resolveFirst = () => new VerificationStore(pool).resolveChallenges(f.decider, admission, f.claim,
    assessment, [first], 'not-established', 'Review complete', nativeId(f.decider));
  await Promise.all([resolveFirst(), resolveFirst()]);
  await resolveFirst();
  expect(await f.store.challengeState(f.claim)).toEqual({ revision: '3', open: 1, resolved: 1 });
  // A different admission cannot decide an already resolved challenge.
  await expect(decide(f, first)).rejects.toThrow('challenge is not pending');
  const withdrawalKey = randomUUID();
  const withdraw = () => f.store.withdrawChallenge(f.principal, withdrawalKey, f.claim, second,
    { reason: 'Counterevidence withdrawn', actingSubject: f.input.actingSubject });
  await Promise.all([withdraw(), withdraw()]);
  await withdraw();
  expect(await f.store.challengeState(f.claim)).toEqual({ revision: '4', open: 0, resolved: 2 });
  expect((await f.store.listChallenges(f.claim)).map(row => row.state)).toEqual(['resolved', 'resolved']);
});

test('distinct decisions serialize only their claim head and a race for one challenge has one effect', async () => {
  const f = fixture();
  const ids = await Promise.all(Array.from({ length: 8 }, () => submit(f)));
  await Promise.all(ids.map(id => decide(f, id)));
  expect(await f.store.challengeState(f.claim)).toEqual({ revision: '16', open: 0, resolved: 8 });
  const raced = await submit(f);
  const outcomes = await Promise.allSettled([decide(f, raced), decide(f, raced)]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(await f.store.challengeState(f.claim)).toEqual({ revision: '18', open: 0, resolved: 9 });
});

test('denied decisions and failed decision inserts roll back the pending leaf and both counts', async () => {
  const f = fixture();
  const challenge = await submit(f);
  const before = await f.store.challengeState(f.claim);
  await expect(f.store.resolveChallenges(f.principal, randomUUID(), f.claim, nativeId(randomUUID()),
    [challenge], 'not-established', 'Submitter may not decide', f.input.actingSubject))
    .rejects.toThrow('a submitter cannot resolve its own challenge');
  await expect(f.store.withdrawChallenge(f.decider, randomUUID(), f.claim, challenge,
    { reason: 'Only submitter may withdraw', actingSubject: nativeId(f.decider) }))
    .rejects.toThrow('a submitter cannot resolve its own challenge');
  expect(await f.store.challengeState(f.claim)).toEqual(before);
  const hook = `challenge_counts_failure_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE FUNCTION verification.${hook}() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'injected challenge decision failure'; END $$`);
  try {
    await pool.query(`CREATE TRIGGER ${hook} AFTER INSERT ON verification.challenge_resolution
      FOR EACH ROW WHEN (NEW.challenge_id = '${challenge}'::uuid)
      EXECUTE FUNCTION verification.${hook}()`);
    try {
      await expect(decide(f, challenge)).rejects.toThrow('injected challenge decision failure');
      expect(await f.store.challengeState(f.claim)).toEqual(before);
      expect((await pool.query('SELECT 1 FROM verification.challenge_pending WHERE challenge_id = $1',
        [challenge])).rowCount).toBe(1);
      expect((await pool.query('SELECT 1 FROM verification.challenge_resolution WHERE challenge_id = $1',
        [challenge])).rowCount).toBe(0);
    } finally { await pool.query(`DROP TRIGGER ${hook} ON verification.challenge_resolution`); }
  } finally { await pool.query(`DROP FUNCTION verification.${hook}()`); }
  await decide(f, challenge);
  expect(await f.store.challengeState(f.claim)).toEqual({ revision: '2', open: 0, resolved: 1 });
});

test('physical leaf retirement maintains counts while ordinary retained-history deletion stays denied', async () => {
  const f = fixture();
  const pending = await submit(f);
  const resolved = await submit(f);
  await decide(f, resolved);
  await expect(pool.query('DELETE FROM verification.challenge WHERE id = $1', [pending]))
    .rejects.toThrow('immutable');
  await expect(pool.query('DELETE FROM verification.challenge_resolution WHERE challenge_id = $1', [resolved]))
    .rejects.toThrow('immutable');
  expect(await f.store.challengeState(f.claim)).toEqual({ revision: '3', open: 1, resolved: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM verification.challenge_pending WHERE challenge_id = $1', [pending]);
    await client.query('ALTER TABLE verification.challenge_resolution DISABLE TRIGGER verification_challenge_resolution_immutable');
    await client.query('DELETE FROM verification.challenge_resolution WHERE challenge_id = $1', [resolved]);
    await client.query('ALTER TABLE verification.challenge_resolution ENABLE TRIGGER verification_challenge_resolution_immutable');
    await client.query('COMMIT');
    expect(await f.store.challengeState(f.claim)).toEqual({ revision: '5', open: 0, resolved: 0 });
    await client.query('BEGIN');
    await client.query('ALTER TABLE verification.challenge DISABLE TRIGGER verification_challenge_immutable');
    await client.query('DELETE FROM verification.challenge WHERE id = ANY($1::uuid[])', [[pending, resolved]]);
    await client.query('ALTER TABLE verification.challenge ENABLE TRIGGER verification_challenge_immutable');
    await client.query('COMMIT');
    expect(await f.store.challengeState(f.claim)).toEqual({ revision: '5', open: 0, resolved: 0 });
    expect((await pool.query('SELECT 1 FROM verification.challenge WHERE claim = $1', [f.claim])).rowCount).toBe(0);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
});

test('challenge changes invalidate only their pinned claim and independent claim writers share no head lock', async () => {
  const f = fixture();
  const other = fixture();
  const unrelated = { ...other, principal: f.principal,
    input: { ...other.input, actingSubject: f.input.actingSubject } };
  const challenge = await submit(f);
  await submit(unrelated);
  const head = (await f.store.challengeState(f.claim)).revision!;
  const target = nativeId(randomUUID());
  const context = 'urn:rezics:context:challenge-counts-summary';
  expect(await f.store.activateSummary({ target, context, claim: f.claim, claimRevision: f.input.claimRevision,
    adoptedRevision: null, assessment: nativeId(randomUUID()), policyRevision: 'urn:rezics:policy:challenge-counts',
    support: 'supported', review: 'reviewed', coverage: 'complete', dependence: 'established',
    reasons: ['review-complete'], dependencies: [{ owner: 'content', kind: 'challenge', reference: f.claim,
      expectedHead: head }], ownerPositions: {}, operationKey: randomUUID(), expectedActive: null,
    observedDemand: null, openChallenges: 1, resolvedChallenges: 0 })).toMatchObject({ status: 'activated' });
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT 1 FROM verification.challenge_head WHERE claim = $1 FOR UPDATE', [f.claim]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([submit(unrelated), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Independent claim waited on another claim head')), 1_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    expect(await f.store.challengeState(f.claim)).toEqual({ revision: head, open: 1, resolved: 0 });
    const unchanged = await f.store.readSummary(target, context);
    expect(unchanged?.dependencies[0]).toMatchObject({ expectedHead: head, currentHead: head });
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  await decide(f, challenge);
  const stale = await f.store.readSummary(target, context);
  expect(stale?.dependencies[0]).toMatchObject({ expectedHead: '1', currentHead: '2' });
  expect(stale?.pendingWork).toBe(true);
  expect(await unrelated.store.challengeState(unrelated.claim)).toEqual({ revision: '2', open: 2, resolved: 0 });
});

test('forward migration backfills populated legacy counts and repairs retired pending leaves once', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const stack = join(root, '.temp', 'stack', `rezics-qa-${Bun.env.REZICS_QA_RUN_ID}`);
  const compose = readEnv(join(stack, 'compose.env'));
  const admin = new Client({ connectionString:
    `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
  const name = `qa_challenge_${randomBytes(6).toString('hex')}`;
  const directory = join(root, '.temp', `challenge-upgrade-${randomUUID()}`);
  const url = new URL(Bun.env.CONTENT_DATABASE_URL!);
  url.pathname = `/${name}`;
  const upgrade = new Pool({ connectionString: url.toString(), max: 4 });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${name} WITH TEMPLATE template0 OWNER content`);
    created = true;
    mkdirSync(directory, { recursive: true });
    for (const file of schemaFiles(root, 'content').filter(file => migrationVersion(file) !== 1522)) {
      symlinkSync(join(root, 'services/content/migrations', file), join(directory, file));
    }
    await migrateContent(upgrade, directory);
    const f = fixture(upgrade);
    const empty = fixture(upgrade);
    const removed = await submit(f);
    await submit(f);
    await history(f, 205);
    await upgrade.query('DELETE FROM verification.challenge_pending WHERE challenge_id = $1', [removed]);
    const old = (await upgrade.query(`SELECT revision::text, open_count FROM verification.challenge_head
      WHERE claim = $1`, [f.claim])).rows[0];
    expect(old).toEqual({ revision: '412', open_count: 2 });
    expect(await migrateContent(upgrade)).toContain(1522);
    expect(await f.store.challengeState(f.claim)).toEqual({ revision: '413', open: 1, resolved: 205 });
    expect(await empty.store.challengeState(empty.claim)).toEqual({ revision: null, open: 0, resolved: 0 });
    expect(await migrateContent(upgrade)).toEqual([]);
    expect(await f.store.challengeState(f.claim)).toEqual({ revision: '413', open: 1, resolved: 205 });
    await history(f, 1);
    expect(await f.store.challengeState(f.claim)).toEqual({ revision: '415', open: 1, resolved: 206 });
  } finally {
    await upgrade.end();
    if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);


test('Content byte erasure retains challenge history and leaves exact counts unchanged', async () => {
  const f = fixture();
  const resource = `urn:rezics:challenge-evidence:${randomUUID()}`;
  const variant = `urn:rezics:variant:${randomUUID()}`;
  const revision = randomUUID();
  const bytes = Buffer.from('{}');
  await pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'zxx', 'none')`, [variant, resource]);
  await pool.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
    byte_digest, byte_length, serialized_bytes, body)
    VALUES ($1, $2, $3, 'rezics-content-json-v1', 'fixture', '{}', $4, 2, $5, '{}')`,
  [revision, variant, `evidence:${revision}`, createHash('sha256').update(bytes).digest('hex'), bytes]);
  const challenge = await f.store.submitChallenge(f.principal, randomUUID(), f.claim, {
    ...f.input, counterevidence: [{ stance: 'contradicts', contentRevision: revision,
      selector: {}, availability: 'available' }],
  });
  const before = await f.store.challengeState(f.claim);
  const access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 2 });
  const command = { preservationAccess: access, erasureId: randomUUID(), erasureEpoch: '1',
    resourceId: resource, revisionIds: [revision] };
  try {
    expect(await applyContentErasure(pool, command)).toEqual({ applied: 1 });
    expect(await applyContentErasure(pool, command)).toEqual({ applied: 0 });
  } finally { await access.end(); }
  expect(await f.store.challengeState(f.claim)).toEqual(before);
  expect((await pool.query(`SELECT availability, serialized_bytes, body FROM content.revision WHERE id = $1`,
    [revision])).rows[0]).toEqual({ availability: 'erased', serialized_bytes: null, body: null });
  const retained = await f.store.readChallenge(f.claim, uuidOf(challenge.challenge.challenge)!);
  expect(retained?.state).toBe('pending');
  expect((await f.store.readEvidence(uuidOf(retained!.counterevidence!)!))?.items[0]?.currentAvailability).toBe('erased');
  await f.store.withdrawChallenge(f.principal, randomUUID(), f.claim, uuidOf(challenge.challenge.challenge)!,
    { reason: 'Withdrawn after byte erasure', actingSubject: f.input.actingSubject });
  expect(await f.store.challengeState(f.claim)).toEqual({ revision: '2', open: 0, resolved: 1 });
}, 90_000);
