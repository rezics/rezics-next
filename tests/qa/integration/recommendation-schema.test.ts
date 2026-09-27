import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { Value } from 'typebox/value';
import { renderProfile } from '../../../model/compiler/ir.ts';
import { eventTimeProfile } from '../../../model/definitions/event-time-v1.ts';
import { valueExactProfile } from '../../../model/definitions/value-exact-v1.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { eventTables } from '../../../services/main/src/modules/event/schema.ts';
import { GRAPH_LAYOUT_MODEL, GraphLayoutBody, graphLayoutTable }
  from '../../../services/main/src/modules/graph-layout/schema.ts';
import { derivedGenerationTables, type TableDeclaration }
  from '../../../services/main/src/modules/recommendation/generation-schema.ts';
import { rankingTables } from '../../../services/main/src/modules/recommendation/ranking-schema.ts';

// G-058 owner schema: Access 110-119 and Content 140-149. Each database is a
// scratch database on the QA PostgreSQL, so shared owner templates stay intact.
const root = resolve(import.meta.dir, '../../..');
const accessDirectory = join(root, 'services/main/migrations/access');
const contentDirectory = join(root, 'services/content/migrations');
const ownAccess = /^11[0-9]_/;
const ownContent = /^14[0-9]_/;
const sqlFiles = (directory: string) => [...new Bun.Glob('*.sql').scanSync({ cwd: directory })].sort();
const id = () => `https://rezics.com/id/${randomUUID()}`;
const hex = (seed: string) => new Bun.CryptoHasher('sha256').update(seed).digest('hex');
const accessDeclarations: TableDeclaration<never>[] = [...derivedGenerationTables, ...rankingTables, ...eventTables];

let adminUrl = '';
const databases: string[] = [];
const pools: Pool[] = [];

async function admin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

async function scratch(label: string): Promise<Pool> {
  const name = `g058_${randomBytes(5).toString('hex')}_${label}`;
  await admin(client => client.query(`CREATE DATABASE ${name}`));
  databases.push(name);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  pools.push(pool);
  return pool;
}

async function applyAccess(pool: Pool, include: (file: string) => boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const file of sqlFiles(accessDirectory).filter(include)) {
      await client.query(readFileSync(join(accessDirectory, file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

/** Columns, constraints, indexes and triggers of the G-058 objects. */
async function signature(pool: Pool, schema: 'access' | 'content', tables: string[]): Promise<string[]> {
  const rows = await pool.query<{ item: string }>(`
    SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable
      || ' ' || coalesce(generation_expression, '') AS item
      FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2)
    UNION ALL SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
      FROM pg_constraint WHERE conrelid::regclass::text = ANY(SELECT $1 || '.' || unnest($2::text[]))
    UNION ALL SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = ANY($2)
    UNION ALL SELECT 'trigger ' || tgrelid::regclass || ' ' || tgname || ' ' || pg_get_triggerdef(oid)
      FROM pg_trigger WHERE NOT tgisinternal
        AND tgrelid::regclass::text = ANY(SELECT $1 || '.' || unnest($2::text[]))
    ORDER BY 1`, [schema, tables]);
  return rows.rows.map(row => row.item);
}

async function declaredColumns(pool: Pool, table: TableDeclaration<never>): Promise<void> {
  const rows = await pool.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [table.schema, table.name]);
  expect(rows.rows.map(row => row.column_name)).toEqual([...table.columns]);
}

/** SQLSTATE plus the owner guard message, so one rejection cannot mask another. */
async function rejects(pool: Pool, sql: string, values: unknown[] = []): Promise<string> {
  try {
    await pool.query(sql, values);
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return `${code ?? 'unknown'} ${message ?? ''}`;
  }
  throw new Error(`expected rejection: ${sql}`);
}

let accessEmpty: Pool;
let accessUpgraded: Pool;
let contentEmpty: Pool;
let contentUpgraded: Pool;
let seededPrincipal = '';

beforeAll(async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) {
    throw new Error('Run through yarn test so the QA project provides REZICS_QA_RUN_ID');
  }
  const compose = readEnv(join(root, '.temp', 'stack', `rezics-qa-${runId}`, 'compose.env'));
  adminUrl = `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`;
  [accessEmpty, accessUpgraded, contentEmpty, contentUpgraded] = await Promise.all(
    ['access_empty', 'access_head', 'content_empty', 'content_head'].map(scratch));
});

afterAll(async () => {
  await Promise.all(pools.map(pool => pool.end()));
  if (adminUrl) {
    await admin(async client => {
      for (const name of databases) await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    });
  }
  // The first DROP DATABASE waits for a checkpoint.
}, 60_000);

test('REC01/RATE07/GRAPH06 partial: owner schemas install empty and upgrade from current head', async () => {
  expect(sqlFiles(accessDirectory).filter(file => ownAccess.test(file)))
    .toEqual(['110_derived_generation.sql', '111_ranking_generation.sql',
      '112_event_interval.sql', '113_ranking_signal_slot.sql',
      '114_ranking_private_selection_revision.sql', '115_ranking_signal_contributor.sql']);
  expect(sqlFiles(contentDirectory).filter(file => ownContent.test(file))).toEqual(['140_graph_layout.sql']);

  await applyAccess(accessEmpty, () => true);
  // Current head is every other Access migration; the upgrade keeps its rows.
  await applyAccess(accessUpgraded, file => !ownAccess.test(file));
  seededPrincipal = randomUUID();
  await accessUpgraded.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, 'https://account.rezics.test', 'g058-upgrade')`, [seededPrincipal]);
  expect((await accessUpgraded.query("SELECT to_regclass('access.derived_generation') AS name")).rows[0].name)
    .toBeNull();
  await applyAccess(accessUpgraded, file => ownAccess.test(file));
  expect((await accessUpgraded.query('SELECT account_subject FROM access.principal WHERE id = $1',
    [seededPrincipal])).rows).toEqual([{ account_subject: 'g058-upgrade' }]);

  await migrateContent(contentEmpty);
  await migrateContent(contentEmpty);
  const headFiles = sqlFiles(contentDirectory).filter(file => Number(file.slice(0, 3)) < 140);
  await contentUpgraded.query(`CREATE SCHEMA content; CREATE TABLE content.schema_migration (
    version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const file of headFiles) {
    await contentUpgraded.query(readFileSync(join(contentDirectory, file), 'utf8'));
    await contentUpgraded.query('INSERT INTO content.schema_migration (version) VALUES ($1)',
      [Number(file.slice(0, 3))]);
  }
  await migrateContent(contentUpgraded);
  const versions = (pool: Pool) => pool.query<{ version: number }>(
    'SELECT version FROM content.schema_migration ORDER BY version').then(result => result.rows.map(row => row.version));
  expect(await versions(contentUpgraded)).toEqual(await versions(contentEmpty));
  expect(await versions(contentEmpty)).toContain(140);

  const accessNames = accessDeclarations.map(table => table.name);
  expect(await signature(accessUpgraded, 'access', accessNames))
    .toEqual(await signature(accessEmpty, 'access', accessNames));
  expect(await signature(contentUpgraded, 'content', ['graph_layout']))
    .toEqual(await signature(contentEmpty, 'content', ['graph_layout']));
  for (const table of accessDeclarations) {
    await declaredColumns(accessEmpty, table);
    await declaredColumns(accessUpgraded, table);
  }
  await declaredColumns(contentEmpty, graphLayoutTable as TableDeclaration<never>);
  await declaredColumns(contentUpgraded, graphLayoutTable as TableDeclaration<never>);
  expect((await accessEmpty.query('SELECT family FROM access.derived_generation_family ORDER BY family'))
    .rows.map(row => row.family)).toEqual(['event-interval', 'ranking']);
});

async function building(pool: Pool, family: 'ranking' | 'event-interval', scope: string): Promise<string> {
  const generation = randomUUID();
  await pool.query(`INSERT INTO access.derived_generation
    (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
    VALUES ($1, $2, $3, $4, $5, clock_timestamp() + interval '5 minutes')`,
  [generation, family, scope, hex(`input:${generation}`), { scope, policy: 'fixture' }]);
  return generation;
}

async function snapshot(pool: Pool, generation: string, sequence: number): Promise<void> {
  await pool.query(`INSERT INTO access.derived_generation_input
    (generation_id, source, data_epoch, pinned_sequence, checkpoint_sequence, snapshot_complete)
    VALUES ($1, 'main-graph', 'epoch-a', $2, $2, true)`, [generation, sequence]);
}

async function ready(pool: Pool, generation: string): Promise<void> {
  await pool.query(`UPDATE access.derived_generation SET state = 'ready', lease_expires_at = NULL,
    validation_digest = $2, ready_at = clock_timestamp() WHERE id = $1`, [generation, hex(`valid:${generation}`)]);
}

test('REC03/REC04 partial: generation lease, readiness and active-head CAS guards', async () => {
  const pool = accessUpgraded;
  const scope = hex('public ranking scope');
  const first = await building(pool, 'ranking', scope);
  expect(await rejects(pool, `INSERT INTO access.ranking_generation
    (generation_id, population, candidate_grain, score_policy, partition_count)
    VALUES ($1, 'personal', 'work', 'https://rezics.com/definition/ranking-fixture-v1', 2)`, [first])).toStartWith('23514');
  expect(await rejects(pool, `INSERT INTO access.ranking_generation
    (generation_id, population, candidate_grain, score_policy, context, partition_count)
    VALUES ($1, 'public', 'work', 'https://rezics.com/definition/ranking-fixture-v1', $2, 2)`,
  [first, id()])).toStartWith('23514');
  await pool.query(`INSERT INTO access.ranking_generation
    (generation_id, population, candidate_grain, score_policy, partition_count)
    VALUES ($1, 'public', 'work', 'https://rezics.com/definition/ranking-fixture-v1', 2)`, [first]);
  await pool.query('INSERT INTO access.ranking_partition (generation_id, partition) VALUES ($1, 0), ($1, 1)', [first]);
  expect(await rejects(pool, 'INSERT INTO access.ranking_partition (generation_id, partition) VALUES ($1, 2)',
    [first])).toStartWith('23514');
  const [top, tied, low] = [id(), id(), id()].sort();
  await pool.query(`INSERT INTO access.ranking_score (generation_id, partition, candidate, score, signal_count)
    VALUES ($1, 0, $2, 5, 3), ($1, 1, $3, 5, 2), ($1, 1, $4, 1.5, 1)`, [first, top, tied, low]);
  expect(await rejects(pool, `INSERT INTO access.ranking_score (generation_id, partition, candidate, score, signal_count)
    VALUES ($1, 0, $2, 0, 1)`, [first, id()])).toStartWith('23514');
  expect(await rejects(pool, `INSERT INTO access.ranking_score (generation_id, partition, candidate, score, signal_count)
    VALUES ($1, 0, $2, 2, 1)`, [first, tied])).toStartWith('23505');

  await pool.query(`INSERT INTO access.derived_generation_input
    (generation_id, source, data_epoch, pinned_sequence, checkpoint_sequence, snapshot_cursor)
    VALUES ($1, 'main-graph', 'epoch-a', 10, 10, 'candidate:0')`, [first]);
  expect(await rejects(pool, `UPDATE access.derived_generation SET state = 'ready', lease_expires_at = NULL,
    validation_digest = $2, ready_at = clock_timestamp() WHERE id = $1`, [first, hex('early')]))
    .toBe('23514 derived generation inputs are incomplete');
  expect(await rejects(pool, `UPDATE access.derived_generation_input SET checkpoint_sequence = 11,
    data_epoch = 'epoch-b' WHERE generation_id = $1`, [first])).toStartWith('23514');
  await pool.query(`UPDATE access.derived_generation_input SET checkpoint_sequence = 12, checkpoint_event = 'event-12',
    snapshot_cursor = NULL, snapshot_complete = true WHERE generation_id = $1`, [first]);
  expect(await rejects(pool, `UPDATE access.derived_generation_input SET checkpoint_sequence = 11
    WHERE generation_id = $1`, [first])).toStartWith('23514');
  await ready(pool, first);
  // Ready scores are frozen: no late coalesced batch changes their order.
  expect(await rejects(pool, `UPDATE access.ranking_score SET score = 9 WHERE generation_id = $1`, [first]))
    .toBe('23514 derived generation rows change only while building');
  expect(await rejects(pool, `DELETE FROM access.ranking_score WHERE generation_id = $1`, [first]))
    .toBe('23514 ready derived generation rows are immutable');
  expect(await rejects(pool, `UPDATE access.derived_generation_input SET checkpoint_sequence = 13
    WHERE generation_id = $1`, [first])).toStartWith('23514');
  expect((await pool.query(`SELECT candidate FROM access.ranking_score WHERE generation_id = $1
    ORDER BY score DESC, candidate`, [first])).rows.map(row => row.candidate)).toEqual([top, tied, low]);

  expect(await rejects(pool, `INSERT INTO access.derived_generation_head (family, scope_key, active_generation, revision)
    VALUES ('ranking', $1, $2, 2)`, [scope, first])).toStartWith('23514');
  await pool.query(`INSERT INTO access.derived_generation_head (family, scope_key, active_generation, revision)
    VALUES ('ranking', $1, $2, 1)`, [scope, first]);
  await pool.query(`INSERT INTO access.derived_generation_activation
    (family, scope_key, revision, generation_id, lease_epoch, input_positions)
    VALUES ('ranking', $1, 1, $2, 1, $3)`, [scope, first,
    JSON.stringify([{ source: 'main-graph', dataEpoch: 'epoch-a', sequence: '12' }])]);
  expect(await rejects(pool, `UPDATE access.derived_generation_activation SET lease_epoch = 2
    WHERE generation_id = $1`, [first])).toStartWith('23514');

  // REC04: a newer lease holder fences the stale worker's exact-epoch writes.
  const second = await building(pool, 'ranking', scope);
  await pool.query(`UPDATE access.derived_generation SET lease_epoch = 2,
    lease_expires_at = clock_timestamp() + interval '5 minutes' WHERE id = $1 AND lease_epoch = 1`, [second]);
  expect((await pool.query(`UPDATE access.derived_generation SET lease_expires_at = clock_timestamp()
    WHERE id = $1 AND lease_epoch = 1 AND state = 'building'`, [second])).rowCount).toBe(0);
  expect(await rejects(pool, 'UPDATE access.derived_generation SET lease_epoch = 1 WHERE id = $1', [second]))
    .toBe('23514 derived generation lease epoch only advances while building');
  expect(await rejects(pool, `UPDATE access.derived_generation_head SET active_generation = $2, revision = 2
    WHERE family = 'ranking' AND scope_key = $1`, [scope, second]))
    .toBe('23514 only a ready derived generation can be activated');
  // REC03: the failed second build leaves the first generation active.
  await pool.query(`UPDATE access.derived_generation SET state = 'failed', lease_expires_at = NULL,
    failure_reason = 'validation failed', finished_at = clock_timestamp() WHERE id = $1`, [second]);
  expect(await rejects(pool, `UPDATE access.derived_generation SET state = 'failed',
    failure_reason = 'stale worker', finished_at = clock_timestamp() WHERE id = $1`, [first]))
    .toBe('23514 active derived generation cannot leave ready');
  expect(await rejects(pool, `UPDATE access.derived_generation SET state = 'ready', ready_at = clock_timestamp(),
    validation_digest = $2, failure_reason = NULL, finished_at = NULL WHERE id = $1`, [second, hex('late')]))
    .toStartWith('23514');
  expect((await pool.query(`SELECT active_generation, revision FROM access.derived_generation_head
    WHERE family = 'ranking' AND scope_key = $1`, [scope])).rows).toEqual([{ active_generation: first, revision: '1' }]);
  expect(await rejects(pool, 'DELETE FROM access.derived_generation WHERE id = $1', [first]))
    .toBe('23514 open derived generation cannot be deleted');

  const third = await building(pool, 'ranking', scope);
  await snapshot(pool, third, 12);
  await ready(pool, third);
  expect(await rejects(pool, `UPDATE access.derived_generation_head SET active_generation = $2, revision = 3
    WHERE family = 'ranking' AND scope_key = $1`, [scope, third]))
    .toBe('23514 derived generation head advances one revision to a new generation');
  expect((await pool.query(`UPDATE access.derived_generation_head SET active_generation = $2, revision = 2,
    activated_at = clock_timestamp() WHERE family = 'ranking' AND scope_key = $1 AND revision = 1`,
  [scope, third])).rowCount).toBe(1);
  await pool.query(`UPDATE access.derived_generation SET state = 'superseded', finished_at = clock_timestamp()
    WHERE id = $1`, [first]);
  expect(await rejects(pool, `UPDATE access.derived_generation SET state = 'building',
    lease_expires_at = clock_timestamp(), finished_at = NULL WHERE id = $1`, [first])).toStartWith('23514');

  // Terminal retention deletes derived rows and cascades the failed build.
  await pool.query('DELETE FROM access.derived_generation WHERE id = $1', [second]);
  await pool.query('DELETE FROM access.ranking_score WHERE generation_id = $1', [first]);
  expect((await pool.query('SELECT count(*)::int AS n FROM access.derived_generation_input WHERE generation_id = $1',
    [second])).rows[0].n).toBe(0);

  const personal = await building(pool, 'ranking', hex(`personal:${seededPrincipal}`));
  await pool.query(`INSERT INTO access.ranking_generation
    (generation_id, population, principal_id, candidate_grain, score_policy, context, context_revision,
     semantic_selection_revision, preference_revision, partition_count)
    VALUES ($1, 'personal', $2, 'main-version', 'https://rezics.com/definition/ranking-fixture-v1',
      $3, $4, $5, $6, 1)`, [personal, seededPrincipal, id(), id(), id(), id()]);
  expect(await rejects(pool, `UPDATE access.ranking_generation SET preference_revision = $2
    WHERE generation_id = $1`, [personal, id()])).toStartWith('23514');
});

test('RATE07/RATE09 partial: event interval keys keep precision and possible versus definite spans', async () => {
  const pool = accessEmpty;
  const generation = await building(pool, 'event-interval', hex('event interval index'));
  const key = (values: Record<string, unknown>) => {
    const row = { generation_id: generation, event: id(), time_revision: id(), time_status: 'actual',
      temporal_kind: 'instant', interpretation: 'civil-date',
      conversion_profile: 'https://rezics.com/definition/event-proleptic-gregorian-civil-v1', ...values };
    const columns = Object.keys(row);
    return pool.query(`INSERT INTO access.event_interval_key (${columns.join(', ')})
      VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')}) RETURNING time_revision`, Object.values(row));
  };
  const known = (precision: string, min: string, max: string) => ({ start_state: 'known', start_precision: precision,
    end_state: 'known', end_precision: precision, civil_start_min: min, civil_start_max: max,
    civil_end_min: min, civil_end_max: max });
  const month = (await key(known('month', '2024-03-01', '2024-03-31'))).rows[0].time_revision;
  const day = (await key(known('day', '2024-03-15', '2024-03-15'))).rows[0].time_revision;
  const ongoing = (await key({ temporal_kind: 'interval', start_state: 'known', start_precision: 'month',
    end_state: 'open', civil_start_min: '2024-01-01', civil_start_max: '2024-01-31' })).rows[0].time_revision;
  const matches = await pool.query<{ time_revision: string; possible: boolean; definite: boolean }>(`
    SELECT time_revision, civil_possible && daterange('2024-03-15', '2024-03-15', '[]') AS possible,
      civil_definite @> '2024-03-15'::date AS definite
      FROM access.event_interval_key WHERE generation_id = $1 ORDER BY civil_start_min, time_revision`, [generation]);
  expect(matches.rows).toEqual([
    { time_revision: ongoing, possible: true, definite: false },
    { time_revision: month, possible: true, definite: false },
    { time_revision: day, possible: true, definite: true },
  ]);
  expect((await pool.query(`SELECT upper_inf(civil_possible) AS open_end, isempty(civil_definite) AS no_definite
    FROM access.event_interval_key WHERE time_revision = $1`, [ongoing])).rows[0])
    .toEqual({ open_end: true, no_definite: true });

  await expect(key({ ...known('day', '2024-03-15', '2024-03-15'), interpretation: 'instant' })).rejects
    .toMatchObject({ code: '23514' });
  await expect(key({ ...known('month', '2024-03-01', '2024-03-31'), start_state: 'unknown' })).rejects
    .toMatchObject({ code: '23514' });
  await expect(key({ ...known('day', '2024-03-15', '2024-03-15'), civil_end_max: '2024-03-16' })).rejects
    .toMatchObject({ code: '23514' });
  await key({ interpretation: 'instant', start_state: 'known', start_precision: 'minute', end_state: 'known',
    end_precision: 'minute', instant_start_min: '2024-03-10T06:30:00Z', instant_start_max: '2024-03-10T06:30:59.999Z',
    instant_end_min: '2024-03-10T06:30:00Z', instant_end_max: '2024-03-10T06:30:59.999Z' });

  await pool.query(`INSERT INTO access.event_histogram_bucket
    (generation_id, time_status, grain, bucket_start, definite_count, possible_count)
    VALUES ($1, 'actual', 'month', '2024-03-01', 1, 3)`, [generation]);
  expect(await rejects(pool, `INSERT INTO access.event_histogram_bucket
    (generation_id, time_status, grain, bucket_start, definite_count, possible_count)
    VALUES ($1, 'actual', 'month', '2024-03-15', 0, 1)`, [generation])).toStartWith('23514');
  expect(await rejects(pool, `INSERT INTO access.event_histogram_bucket
    (generation_id, time_status, grain, bucket_start, definite_count, possible_count)
    VALUES ($1, 'actual', 'year', '2024-01-01', 2, 1)`, [generation])).toStartWith('23514');

  const ranking = await building(pool, 'ranking', hex('not an event index'));
  await expect(key({ ...known('day', '2024-03-15', '2024-03-15'), generation_id: ranking })).rejects
    .toMatchObject({ code: '23503' });

  // RATE09: a date change during the rebuild is applied before readiness; afterwards the generation is fenced.
  await snapshot(pool, generation, 40);
  await pool.query(`UPDATE access.derived_generation_input SET checkpoint_sequence = 41, checkpoint_event = 'date-change'
    WHERE generation_id = $1`, [generation]);
  await pool.query(`UPDATE access.event_interval_key SET civil_start_min = '2024-03-02', civil_end_min = '2024-03-02'
    WHERE time_revision = $1`, [month]);
  await ready(pool, generation);
  expect(await rejects(pool, `UPDATE access.event_interval_key SET civil_start_min = '2024-03-03',
    civil_end_min = '2024-03-03' WHERE time_revision = $1`, [month]))
    .toBe('23514 derived generation rows change only while building');
  expect(await rejects(pool, `UPDATE access.event_histogram_bucket SET possible_count = 4
    WHERE generation_id = $1`, [generation])).toStartWith('23514');
});

test('GRAPH06 partial: saved layout binds a non-linguistic Content variant, never graph truth', async () => {
  const pool = contentEmpty;
  const core = new ContentCore(pool);
  const layout = id();
  const variant = { id: `urn:rezics:graph-layout:${randomUUID()}`, resourceId: layout,
    language: { kind: 'zxx' as const }, direction: 'none' as const };
  const body = { view: { profile: 'https://rezics.com/definition/graph-appearance-view-v1', anchor: id(),
    context: null }, nodes: [{ resource: id(), x: 10, y: -4.5, group: 'cast', pinned: true }],
  groups: [{ id: 'cast', label: 'Cast', x: 0, y: 0, collapsed: false }] };
  expect(Value.Check(GraphLayoutBody, body)).toBe(true);
  expect(Value.Check(GraphLayoutBody, { ...body, nodes: [{ ...body.nodes[0], relation: id() }] })).toBe(false);
  const saved = await core.saveDraft({ operationId: `graph-layout-${randomUUID()}`, variant, expectedHead: null,
    model: GRAPH_LAYOUT_MODEL, sourceRevision: null, serializedJson: JSON.stringify(body),
    provenance: { kind: 'graph-layout-owner-v1', owner: body.view.anchor } });
  expect(saved.outcome).toBe('succeeded');
  const receipt = (await pool.query<{ operation_id: string }>(
    'SELECT operation_id FROM content.receipt WHERE revision_id = $1', [saved.revisionId])).rows[0]!.operation_id;
  const owner = id();
  const insert = (values: { layout: string; variant: string }) => pool.query(`INSERT INTO content.graph_layout
    (id, variant_id, owner_subject, view_profile, anchor, operation_id)
    VALUES ($1, $2, $3, $4, $5, $6)`, [values.layout, values.variant, owner, body.view.profile, body.view.anchor, receipt]);
  await expect(insert({ layout: id(), variant: variant.id })).rejects.toMatchObject({ code: '23514' });
  await insert({ layout, variant: variant.id });
  expect(await rejects(pool, `UPDATE content.graph_layout SET anchor = $2 WHERE id = $1`, [layout, id()])).toStartWith('23514');
  expect(await rejects(pool, 'DELETE FROM content.graph_layout WHERE id = $1', [layout])).toStartWith('23514');
  expect((await pool.query(`SELECT r.model, v.language_kind, v.draft_head = r.id AS current
    FROM content.graph_layout g JOIN content.variant v ON v.id = g.variant_id
    JOIN content.revision r ON r.variant_id = v.id WHERE g.id = $1`, [layout])).rows)
    .toEqual([{ model: GRAPH_LAYOUT_MODEL, language_kind: 'zxx', current: true }]);
});

test('RATE08 partial: known Event time uses one exact temporal value', () => {
  const time = renderProfile(eventTimeProfile);
  for (const shape of ['event', 'slot', 'revision', 'point']) {
    expect(time).toContain(`<https://rezics.com/definition/event-time-v1/${shape}-shape>`);
  }
  expect(time).toContain('sh:in ( rv:ActualTime rv:PlannedTime )');
  expect(time).toContain('sh:path rv:temporalValue ; sh:minCount 1 ; sh:maxCount 1');
  expect(time).not.toContain('rv:sourceLexical');
  const exactValues = renderProfile(valueExactProfile);
  expect(exactValues).toContain('<https://rezics.com/definition/value-exact-v1/temporal-shape>');
  expect(exactValues).toContain('sh:path rv:lexicalForm ; sh:minCount 1 ; sh:maxCount 1');
});
