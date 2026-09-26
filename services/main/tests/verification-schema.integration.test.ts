import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { migrateContent } from '../../content/src/migrate.ts';
import { verificationColumns, verificationEnumerations, verificationLimits,
  type VerificationRows } from '../src/modules/verification/schema.ts';

const root = resolve(import.meta.dir, '../../..');
const migrations = join(root, 'services/content/migrations');
const FIRST_VERIFICATION = 90;
const id = () => crypto.randomUUID();
const native = () => `https://rezics.com/id/${crypto.randomUUID()}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function tx<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

// pg reports the violated constraint separately from the message.
const describe = (error: unknown) => `${(error as Error).message} ${(error as { constraint?: string }).constraint ?? ''}`;

async function rejects(pool: Pool, pattern: RegExp, work: (client: PoolClient) => Promise<unknown>) {
  let failure: unknown;
  try { await tx(pool, work); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(describe(failure)).toMatch(pattern);
}

async function receipt(client: PoolClient, principal: string, action: string, result: string) {
  const operation = id();
  await client.query(`INSERT INTO verification.receipt
    (id, principal_id, action, idempotency_key, request_digest, outcome, result_id)
    VALUES ($1, $2, $3, $4, $5, 'succeeded', $6)`, [operation, principal, action, `key-${operation}`, sha(operation), result]);
  return operation;
}

interface Fixture { principal: string; observations: string[]; contentRevision: string }

async function sourceFixture(pool: Pool): Promise<Fixture> {
  const principal = id();
  const record = id();
  const observations = [id(), id(), id(), id()];
  const variant = `urn:rezics:variant:${id()}`;
  const contentRevision = id();
  await tx(pool, async client => {
    await client.query(`INSERT INTO source.record (id, provider, namespace, external_id)
      VALUES ($1, 'fixture', 'work', $2)`, [record, record]);
    for (const observation of observations) {
      await client.query(`INSERT INTO source.observation (id, record_id, principal_id, media_type, retention,
        coverage, rights_evidence) VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{}')`,
      [observation, record, principal]);
    }
    await client.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
      VALUES ($1, 'urn:rezics:work:fixture', 'zxx', 'none')`, [variant]);
    await client.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
      byte_digest, byte_length, serialized_bytes, body) VALUES ($1, $2, $3, 'rezics-content-json-v1',
      'fixture', '{}', $4, 2, '\\x7b7d', '{}')`, [contentRevision, variant, `op-${contentRevision}`, sha('{}')]);
  });
  return { principal, observations, contentRevision };
}

interface Item { stance: string; observation?: string; content?: string; graph?: string }

async function evidence(client: PoolClient, principal: string, claim: string, purpose: string,
  predecessor: string | null, items: Item[], itemCount = items.length) {
  const revision = id();
  const operation = await receipt(client, principal, 'evidence.record', revision);
  await client.query(`INSERT INTO verification.evidence_set_revision (id, claim, claim_revision, purpose,
    predecessor, item_count, manifest_digest, operation_id, principal_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [revision, claim, native(), purpose, predecessor, itemCount, sha(revision), operation, principal]);
  for (const [ordinal, item] of items.entries()) {
    await client.query(`INSERT INTO verification.evidence_item (revision_id, ordinal, stance, observation_id,
      content_revision_id, graph_reference, selector, availability) VALUES ($1, $2, $3, $4, $5, $6, $7, 'available')`,
    [revision, ordinal, item.stance, item.observation ?? null, item.content ?? null, item.graph ?? null,
      { kind: 'fixture', ordinal }]);
  }
  return revision;
}

async function generation(client: PoolClient, target: string, context: string, number: number,
  predecessor: string | null, dependencies: [string, string, string | null][], count = dependencies.length) {
  const generationId = id();
  await client.query(`INSERT INTO verification.summary_generation (id, target, context, generation, predecessor,
    claim, claim_revision, assessment, policy_revision, support, review, dispute, coverage, dependence,
    reason_codes, dependency_count, dependency_digest, owner_positions, operation_key)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'https://rezics.com/definition/fixture-policy-v1', 'supported',
      'unreviewed', 'none', 'complete', 'unknown', ARRAY['dependence-unknown'], $9, $10, $11, $12)`,
  [generationId, target, context, number, predecessor, native(), native(), native(), count, sha(generationId),
    { graph: { datasetId: 'product', dataEpoch: 'fixture', sequence: String(number) } }, `build:${generationId}`]);
  for (const [ordinal, [kind, reference, head]] of dependencies.entries()) {
    await client.query(`INSERT INTO verification.summary_dependency
      (generation_id, ordinal, owner, kind, reference, expected_head) VALUES ($1, $2, 'graph', $3, $4, $5)`,
    [generationId, ordinal, kind, reference, head]);
  }
  return generationId;
}

async function assertCatalog(pool: Pool) {
  for (const [table, columns] of Object.entries(verificationColumns)) {
    const actual = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'verification' AND table_name = $1 ORDER BY ordinal_position`, [table]);
    expect({ table, columns: actual.rows.map(row => row.column_name) }).toEqual({ table, columns: [...columns] });
  }
  const tables = await pool.query<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = 'verification' ORDER BY table_name`);
  expect(tables.rows.map(row => row.name)).toEqual(Object.keys(verificationColumns).sort());
  for (const [table, column, values] of verificationEnumerations) {
    const definitions = await pool.query<{ definition: string }>(`SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'c' AND c.conrelid = $1::regclass AND a.attname = $2 AND cardinality(c.conkey) = 1`,
    [`verification.${table}`, column]);
    const listed = definitions.rows.flatMap(row => [...row.definition.matchAll(/'([^']+)'::text/g)].map(match => match[1]));
    expect({ table, column, values: [...new Set(listed)].sort() }).toEqual({ table, column, values: [...values].sort() });
  }
}

test('FACT01-FACT04 owner schema: Content verification migrations install empty and upgrade from head', async () => {
  const state = join(root, '.temp', `verification-schema-${crypto.randomUUID()}`);
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', join(state, 'pgdata'), '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', join(state, 'pgdata'), '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const admin = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 2 });
  const connect = (database: string) => new Pool({ host: '127.0.0.1', port, user: process.env.USER, database, max: 6 });
  const local = readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()
    .map(name => ({ name, version: Number(name.slice(0, 3)) }));
  const ours = local.filter(item => item.version >= FIRST_VERIFICATION && item.version < 100);
  expect(ours.map(item => item.name)).toEqual(['090_verification_lineage.sql', '091_verification_evidence.sql',
    '092_verification_challenge.sql', '093_verification_summary.sql']);
  try {
    // Empty install through the owner runner, twice (the second run is a no-op).
    await admin.query('CREATE DATABASE fresh');
    const pool = connect('fresh');
    // Upgrade: a Content owner at the current head (every migration before the
    // verification range) with retained source and Content rows.
    await admin.query('CREATE DATABASE upgrade');
    const older = connect('upgrade');
    try {
      await migrateContent(pool);
      await migrateContent(pool);
      const versions = await pool.query<{ version: number }>('SELECT version FROM content.schema_migration ORDER BY version');
      expect(versions.rows.map(row => row.version)).toEqual(local.map(item => item.version));
      await assertCatalog(pool);

      await older.query(`CREATE SCHEMA content; CREATE TABLE content.schema_migration (version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const item of local.filter(entry => entry.version < FIRST_VERIFICATION)) {
        await older.query(readFileSync(join(migrations, item.name), 'utf8'));
        await older.query('INSERT INTO content.schema_migration (version) VALUES ($1)', [item.version]);
      }
      const retained = await sourceFixture(older);
      await migrateContent(older);
      const upgraded = await older.query<{ version: number }>('SELECT version FROM content.schema_migration ORDER BY version');
      expect(upgraded.rows.map(row => row.version)).toEqual(local.map(item => item.version));
      await assertCatalog(older);
      // Retained observations become evidence anchors without rewriting them.
      const retainedClaim = native();
      await tx(older, async client => {
        const revision = await evidence(client, retained.principal, retainedClaim, 'claim-head', null,
          [{ stance: 'supports', observation: retained.observations[0] }, { stance: 'uncertain', content: retained.contentRevision }]);
        await client.query('INSERT INTO verification.evidence_head (claim, head) VALUES ($1, $2)', [retainedClaim, revision]);
      });
      const kept = await older.query('SELECT count(*)::int AS n FROM source.observation');
      expect(kept.rows[0].n).toBe(4);

      await lineageInvariants(pool);
      await evidenceInvariants(pool);
      await challengeInvariants(pool);
      await invalidationInvariants(pool, await summaryInvariants(pool));
    } finally {
      await pool.end();
      await older.end();
    }
  } finally {
    await admin.end();
    execFileSync('pg_ctl', ['-D', join(state, 'pgdata'), '-m', 'fast', '-w', 'stop'], { cwd: state });
  }
}, 120_000);

// FACT01/FACT02: lineage and derivation are exact, complete and append-only.
async function lineageInvariants(pool: Pool) {
  const { principal, observations: [first, copy, output, other] } = await sourceFixture(pool);
  const origin = id();
  await tx(pool, async client => {
    await client.query(`INSERT INTO verification.origin (id, kind, locator, operation_id, principal_id)
      VALUES ($1, 'publication', 'https://publisher.example/release', $2, $3)`,
    [origin, await receipt(client, principal, 'origin.record', origin), principal]);
    for (const [observation, relation, target, basis] of [
      [first, 'publishes-origin', origin, 'declared-by-source'], [copy, 'copy-of', first, 'detected']] as const) {
      const edge = id();
      await client.query(`INSERT INTO verification.lineage_edge (id, observation_id, relation,
        target_observation_id, target_origin_id, basis, method, operation_id, principal_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [edge, observation, relation,
        relation === 'copy-of' ? target : null, relation === 'publishes-origin' ? target : null, basis,
        basis === 'detected' ? 'https://rezics.com/definition/fixture-copy-detector-v1' : null,
        await receipt(client, principal, 'lineage.record', edge), principal]);
    }
  });
  const edge = (observation: string, relation: string, target: string, second: string | null = null) =>
    async (client: PoolClient) => {
      const edgeId = id();
      await client.query(`INSERT INTO verification.lineage_edge (id, observation_id, relation,
        target_observation_id, target_reference, basis, operation_id, principal_id)
        VALUES ($1, $2, $3, $4, $5, 'declared-by-source', $6, $7)`,
      [edgeId, observation, relation, target, second, await receipt(client, principal, 'lineage.record', edgeId), principal]);
    };
  await rejects(pool, /lineage_edge_identity/, edge(copy, 'copy-of', first));
  await rejects(pool, /lineage_edge_check/, edge(copy, 'copy-of', copy));
  await rejects(pool, /lineage_edge_check/, edge(other, 'copy-of', first, native()));
  await rejects(pool, /immutable verification record/, client =>
    client.query('DELETE FROM verification.lineage_edge WHERE observation_id = $1', [copy]));

  const derivation = (inputs: string[], count: number, model: string | null) => async (client: PoolClient) => {
    const derivationId = id();
    await client.query(`INSERT INTO verification.derivation (id, output_observation_id, kind, method, model,
      limitations, input_count, operation_id, principal_id) VALUES ($1, $2, 'ai-extraction',
      'https://rezics.com/definition/fixture-extractor-v1', $3, 'Fixture model output; unverified.', $4, $5, $6)`,
    [derivationId, output, model, count, await receipt(client, principal, 'derivation.record', derivationId), principal]);
    for (const [ordinal, input] of inputs.entries()) {
      await client.query(`INSERT INTO verification.derivation_input (derivation_id, ordinal, input_observation_id)
        VALUES ($1, $2, $3)`, [derivationId, ordinal, input]);
    }
    return derivationId;
  };
  await rejects(pool, /derivation_check/, derivation([first, copy], 2, null));
  await rejects(pool, /derivation_complete_inputs/, derivation([first], 2, 'fixture-model-1'));
  const recorded = await tx(pool, derivation([first, copy], 2, 'fixture-model-1'));
  await rejects(pool, /derivation_complete_inputs/, client => client.query(`INSERT INTO verification.derivation_input
    (derivation_id, ordinal, input_observation_id) VALUES ($1, 2, $2)`, [recorded, other]));
  await rejects(pool, /derivation_output_observation_id_key/, derivation([other], 1, 'fixture-model-2'));
}

// FACT01/FACT04: complete manifests, one linear claim chain and exact head CAS.
async function evidenceInvariants(pool: Pool) {
  const { principal, observations, contentRevision } = await sourceFixture(pool);
  const claim = native();
  const items: Item[] = [{ stance: 'supports', observation: observations[0] },
    { stance: 'contradicts', content: contentRevision }, { stance: 'uncertain', graph: native() }];
  await rejects(pool, /evidence_head_activated/, client => evidence(client, principal, claim, 'claim-head', null, items));
  await rejects(pool, /evidence_complete_manifest/, async client => {
    const revision = await evidence(client, principal, claim, 'claim-head', null, items.slice(0, 2), 3);
    await client.query('INSERT INTO verification.evidence_head (claim, head) VALUES ($1, $2)', [claim, revision]);
  });
  await rejects(pool, /evidence_set_revision_item_count_check/, client =>
    evidence(client, principal, claim, 'challenge', null, [], verificationLimits.evidenceItems + 1));
  const first = await tx(pool, async client => {
    const revision = await evidence(client, principal, claim, 'claim-head', null, items);
    await client.query('INSERT INTO verification.evidence_head (claim, head) VALUES ($1, $2)', [claim, revision]);
    return revision;
  });
  await rejects(pool, /immutable verification record/, client =>
    client.query('UPDATE verification.evidence_item SET stance = $1 WHERE revision_id = $2', ['supports', first]));
  await rejects(pool, /evidence_chain_root/, async client => {
    const unrelated = await evidence(client, principal, claim, 'claim-head', null, items);
    await client.query('UPDATE verification.evidence_head SET head = $1 WHERE claim = $2', [unrelated, claim]);
  });
  // The head cannot skip an intermediate revision, even within one transaction.
  await rejects(pool, /evidence_head_exact_predecessor/, async client => {
    const middle = await evidence(client, principal, claim, 'claim-head', first, items);
    const last = await evidence(client, principal, claim, 'claim-head', middle, items);
    await client.query('UPDATE verification.evidence_head SET head = $1 WHERE claim = $2', [last, claim]);
  });

  // Two writers extend the same head concurrently: exactly one commits.
  const advance = () => tx(pool, async client => {
    const revision = await evidence(client, principal, claim, 'claim-head', first, items.slice(0, 1));
    const moved = await client.query('UPDATE verification.evidence_head SET head = $1 WHERE claim = $2 AND head = $3',
      [revision, claim, first]);
    if (moved.rowCount !== 1) throw new Error('stale evidence head');
    return revision;
  });
  const raced = await Promise.allSettled([advance(), advance()]);
  expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const loser = raced.find(result => result.status === 'rejected') as PromiseRejectedResult;
  expect(describe(loser.reason)).toMatch(/evidence_chain_successor|stale evidence head/);
  await rejects(pool, /evidence_head_transition|cannot return to absence/, client =>
    client.query('DELETE FROM verification.evidence_head WHERE claim = $1', [claim]));
  await rejects(pool, /evidence_set_revision_check/, client =>
    evidence(client, principal, claim, 'challenge', first, items));
  const rows = await pool.query<VerificationRows['evidence_set_revision']>(
    'SELECT * FROM verification.evidence_set_revision WHERE claim = $1 ORDER BY created_at', [claim]);
  expect(rows.rows.map(row => row.predecessor)).toEqual([null, first]);
}

// FACT03/FACT06: pending challenge, independent resolution, retained disagreement.
async function challengeInvariants(pool: Pool) {
  const { principal: submitter, observations } = await sourceFixture(pool);
  const reviewer = id();
  const claim = native();
  const headRevision = await tx(pool, async client => {
    const revision = await evidence(client, submitter, claim, 'claim-head', null, [{ stance: 'supports', observation: observations[0] }]);
    await client.query('INSERT INTO verification.evidence_head (claim, head) VALUES ($1, $2)', [claim, revision]);
    return revision;
  });
  const submit = (counterevidence: (client: PoolClient) => Promise<string>) => tx(pool, async client => {
    const challenge = id();
    await client.query(`INSERT INTO verification.challenge (id, claim, claim_revision, context, reason, counterevidence,
      acting_subject, operation_id, principal_id) VALUES ($1, $2, $3, 'urn:rezics:context:fixture',
      'The later release date belongs to the second edition.', $4, $5, $6, $7)`,
    [challenge, claim, native(), await counterevidence(client), native(),
      await receipt(client, submitter, 'challenge.submit', challenge), submitter]);
    return challenge;
  });
  let failure: unknown;
  try { await submit(async () => headRevision); } catch (error) { failure = error; }
  expect(describe(failure)).toMatch(/challenge_counterevidence_claim_counterevidence_purpose_fkey/);
  const challenge = await submit(client => evidence(client, submitter, claim, 'challenge', null,
    [{ stance: 'contradicts', observation: observations[1] }]));
  const head = await pool.query<VerificationRows['challenge_head']>('SELECT * FROM verification.challenge_head WHERE claim = $1', [claim]);
  expect([head.rows[0]?.revision, head.rows[0]?.open_count]).toEqual(['1', 1]);
  const resolve = (principal: string, outcome: string, assessment: string | null) => async (client: PoolClient) => {
    await client.query(`INSERT INTO verification.challenge_resolution (challenge_id, outcome, assessment, reason,
      acting_subject, operation_id, principal_id) VALUES ($1, $2, $3, 'Qualified assessment recorded.', $4, $5, $6)`,
    [challenge, outcome, assessment, native(), await receipt(client, principal, 'challenge.resolve', challenge), principal]);
  };
  await rejects(pool, /challenge_independent_resolution/, resolve(submitter, 'material-conflict', native()));
  await rejects(pool, /challenge_independent_resolution/, resolve(reviewer, 'withdrawn', null));
  await rejects(pool, /challenge_resolution_check/, resolve(reviewer, 'material-conflict', null));
  await tx(pool, resolve(reviewer, 'material-conflict', native()));
  await rejects(pool, /challenge_pending_once/, resolve(reviewer, 'not-established', native()));
  const after = await pool.query(`SELECT h.revision, h.open_count,
      (SELECT count(*)::int FROM verification.challenge_pending WHERE claim = $1) AS pending,
      (SELECT count(*)::int FROM verification.challenge WHERE claim = $1) AS retained
    FROM verification.challenge_head h WHERE h.claim = $1`, [claim]);
  expect(after.rows[0]).toEqual({ revision: '2', open_count: 0, pending: 0, retained: 1 });
}

// FACT04: generation CAS, stale-worker refusal and an exact active reverse index.
async function summaryInvariants(pool: Pool) {
  const target = native();
  const context = 'urn:rezics:context:fixture';
  const source = native();
  const deps = (head: string): [string, string, string | null][] =>
    [['claim', target, native()], ['source-assessment', source, head], ['challenge', target, null]];
  const g1 = await tx(pool, async client => {
    const created = await generation(client, target, context, 1, null, deps('h1'));
    await client.query(`INSERT INTO verification.summary_head (target, context, active_generation, generation)
      VALUES ($1, $2, $3, 1)`, [target, context, created]);
    return created;
  });
  const activate = (number: number, predecessor: string, head: string, expectedActive = predecessor) =>
    tx(pool, async client => {
      const created = await generation(client, target, context, number, predecessor, deps(head));
      const moved = await client.query(`UPDATE verification.summary_head SET active_generation = $1, generation = $2
        WHERE target = $3 AND context = $4 AND active_generation = $5`, [created, number, target, context, expectedActive]);
      if (moved.rowCount !== 1) throw new Error('stale summary generation');
      return created;
    });
  const raced = await Promise.allSettled([activate(2, g1, 'h2'), activate(2, g1, 'h2b')]);
  expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const g2 = (raced.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
  // A stale worker built on g1 cannot replace g2 even without the CAS predicate.
  await rejects(pool, /summary_head_exact_successor/, async client => {
    const stale = await generation(client, target, context, 3, g1, deps('h-stale'));
    await client.query(`UPDATE verification.summary_head SET active_generation = $1, generation = 3
      WHERE target = $2 AND context = $3`, [stale, target, context]);
  });
  await rejects(pool, /summary_generation_activated/, client => generation(client, target, context, 3, g2, deps('h3')));
  await rejects(pool, /summary_complete_manifest/, async client => {
    const partial = await generation(client, target, context, 3, g2, deps('h3').slice(0, 2), 3);
    await client.query(`UPDATE verification.summary_head SET active_generation = $1, generation = 3
      WHERE target = $2 AND context = $3`, [partial, target, context]);
  });
  await rejects(pool, /summary_active_index/, async client => {
    const late = await generation(client, target, context, 3, g2, [], 3);
    await client.query(`UPDATE verification.summary_head SET active_generation = $1, generation = 3
      WHERE target = $2 AND context = $3`, [late, target, context]);
    for (const [ordinal, [kind, reference, head]] of deps('h3').entries()) {
      await client.query(`INSERT INTO verification.summary_dependency
        (generation_id, ordinal, owner, kind, reference, expected_head) VALUES ($1, $2, 'graph', $3, $4, $5)`,
      [late, ordinal, kind, reference, head]);
    }
  });
  const index = await pool.query<VerificationRows['active_dependency']>(`SELECT * FROM verification.active_dependency
    WHERE target = $1 AND context = $2 ORDER BY kind`, [target, context]);
  expect(index.rows.map(row => [row.kind, row.generation_id])).toEqual(
    [['challenge', g2], ['claim', g2], ['source-assessment', g2]]);
  expect(index.rows.find(row => row.kind === 'challenge')?.expected_head).toBeNull();
  const reverse = await pool.query(`EXPLAIN (FORMAT JSON) SELECT target, context FROM verification.active_dependency
    WHERE kind = 'source-assessment' AND reference = $1 AND (target, context) > ('', '') ORDER BY target, context LIMIT 50`, [source]);
  expect(JSON.stringify(reverse.rows[0])).toContain('active_dependency_pkey');
  return { target, context };
}

// FACT04: one producer event identity has one durable, monotone work row.
async function invalidationInvariants(pool: Pool, summary: { target: string; context: string }) {
  const event = `urn:rezics:event:${sha('fixture-event')}`;
  const insert = () => pool.query(`INSERT INTO verification.invalidation (id, producer, event_key, kind, reference,
    changed_head, producer_epoch, producer_sequence) VALUES ($1, 'graph', $2, 'source-assessment', $3, $4, 'epoch-a', 7)
    ON CONFLICT (producer, event_key) DO NOTHING`, [id(), event, native(), native()]);
  expect((await insert()).rowCount).toBe(1);
  expect((await insert()).rowCount).toBe(0);
  const work = await pool.query<VerificationRows['invalidation']>(
    'SELECT * FROM verification.invalidation WHERE event_key = $1', [event]);
  const row = work.rows[0]!;
  await pool.query(`UPDATE verification.invalidation SET cursor_target = 'https://rezics.com/id/m', cursor_context = 'c',
    pages = 1, marked = 50 WHERE id = $1`, [row.id]);
  await rejects(pool, /may only advance/, client => client.query(`UPDATE verification.invalidation
    SET cursor_target = 'https://rezics.com/id/a', cursor_context = 'c' WHERE id = $1`, [row.id]));
  await pool.query(`UPDATE verification.invalidation SET state = 'complete', completed_at = clock_timestamp()
    WHERE id = $1`, [row.id]);
  await rejects(pool, /may only advance/, client =>
    client.query('UPDATE verification.invalidation SET pages = 2 WHERE id = $1', [row.id]));
  await rejects(pool, /retained/, client => client.query('DELETE FROM verification.invalidation WHERE id = $1', [row.id]));

  // Many invalidations reaching one summary coalesce into one reassessment demand.
  const demand = (invalidation: string) => pool.query(`INSERT INTO verification.reassessment_request
    (target, context, first_invalidation, latest_invalidation) VALUES ($1, $2, $3, $3)
    ON CONFLICT (target, context) DO UPDATE SET latest_invalidation = EXCLUDED.latest_invalidation,
      marks = reassessment_request.marks + 1, updated_at = clock_timestamp()`,
  [summary.target, summary.context, invalidation]);
  await demand(row.id);
  await demand(row.id);
  const requests = await pool.query<VerificationRows['reassessment_request']>(
    'SELECT * FROM verification.reassessment_request WHERE target = $1', [summary.target]);
  expect(requests.rows.map(request => request.marks)).toEqual(['2']);
  await rejects(pool, /reassessment_request_target_context_fkey/, client => client.query(`INSERT INTO
    verification.reassessment_request (target, context, first_invalidation, latest_invalidation)
    VALUES ($1, 'urn:rezics:context:fixture', $2, $2)`, [native(), row.id]));
}
