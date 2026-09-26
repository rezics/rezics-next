import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type QueryResult } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';

const migrations = resolve(import.meta.dir, '../../../services/content/migrations');
const HEAD = ['005_source_intake.sql', '006_source_capture.sql', '007_source_conversion.sql',
  '008_source_native_work_proposal.sql', '009_source_native_work_adoption.sql',
  '010_source_native_work_title_application.sql', '011_source_child_correspondence.sql',
  '017_source_title_support_withdrawal.sql', '018_source_title_support_attachment.sql',
  '019_source_author_credit.sql', '021_work_title_control.sql'];
const NEW = ['040_source_acquisition_run.sql', '041_source_feed_cursor.sql',
  '042_source_field_disposition.sql', '043_source_field_support.sql', '044_source_provider_identity.sql'];
const TABLES = ['acquisition_run', 'acquisition_run_surface', 'run_capture', 'run_surface_outcome',
  'acquisition_run_completion', 'feed', 'feed_checkpoint', 'feed_head', 'feed_open_gap', 'field_mapping',
  'field_disposition', 'field_support', 'field_support_step', 'field_support_outcome',
  'field_support_withdrawal', 'field_support_head', 'record_identity_change', 'identity_correction_proposal'];

type Query = (text: string, params?: unknown[]) => Promise<QueryResult>;
const iri = () => `https://rezics.com/id/${randomUUID()}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

let pool: Pool;
const schemas: string[] = [];

beforeAll(() => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  pool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 6 });
});
afterAll(async () => {
  for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

/** A private schema replays the exact owner DDL without touching the stack's source owner. */
function owner(label: string) {
  const schema = `source_${label}_${randomUUID().replaceAll('-', '')}`;
  schemas.push(schema);
  const sql = (text: string) => text.replace(/\bsource\./g, `${schema}.`)
    .replace('CREATE SCHEMA IF NOT EXISTS source;', `CREATE SCHEMA IF NOT EXISTS ${schema};`);
  const run: Query = (text, params = []) => pool.query(sql(text), params);
  const apply = async (files: string[]) => {
    for (const name of files) await pool.query(sql(readFileSync(resolve(migrations, name), 'utf8')));
  };
  const tx = async (body: (query: Query) => Promise<void>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await body((text, params = []) => client.query(sql(text), params));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  };
  const record = async (provider = 'fixture', namespace = 'work') => (await run(
    `INSERT INTO source.record (id, provider, namespace, external_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [randomUUID(), provider, namespace, randomUUID()])).rows[0]!.id as string;
  const observation = async (recordId: string, principal: string,
    retention: 'retained' | 'not-retained' = 'retained', revision: string | null = null) => {
    const bytes = retention === 'retained' ? Buffer.from(`{"n":"${randomUUID()}"}`) : null;
    return (await run(`INSERT INTO source.observation (id, record_id, principal_id, source_revision, media_type,
      retention, raw_bytes, byte_digest, coverage, rights_evidence) VALUES ($1,$2,$3,$4,'application/json',$5,$6,$7,
      '{"scope":"record","complete":true,"omittedFields":[]}','{"basis":"unknown","note":""}') RETURNING id`,
    [randomUUID(), recordId, principal, revision, retention, bytes,
      bytes ? createHash('sha256').update(bytes).digest('hex') : null])).rows[0]!.id as string;
  };
  return { schema, run, apply, tx, record, observation };
}
type Owner = ReturnType<typeof owner>;

async function createRun(o: Owner, principal: string, surfaces: Array<{ surface: string; required?: boolean;
  limit?: number; requested?: 'retained' | 'not-retained'; terms?: 'permitted' | 'prohibited' }>,
declared = surfaces.length, provider = 'fixture') {
  const id = randomUUID();
  await o.tx(async query => {
    await query(`INSERT INTO source.acquisition_run (id, principal_id, provider, profile, surface_count,
      idempotency_key, request_digest) VALUES ($1,$2,$3,'fixture-run-v1',$4,$5,$6)`,
    [id, principal, provider, declared, `run-${id}`, sha(id)]);
    for (const [ordinal, item] of surfaces.entries()) {
      await query(`INSERT INTO source.acquisition_run_surface (run_id, surface, ordinal, required, capture_limit,
        requested_retention, retention_terms, terms_reference) VALUES ($1,$2,$3,$4,$5,$6,$7,'https://example.test/terms')`,
      [id, item.surface, ordinal, item.required ?? true, item.limit ?? 8, item.requested ?? 'retained',
        item.terms ?? 'permitted']);
    }
  });
  return id;
}
const capture = (o: Owner, run: string, surface: string, observation: string, ordinal: number,
  requestKey = `GET /${randomUUID()}`) => o.run(`INSERT INTO source.run_capture (id, run_id, surface, ordinal, role,
    request_key, observation_id) VALUES ($1,$2,$3,$4,'response',$5,$6) RETURNING id`,
[randomUUID(), run, surface, ordinal, requestKey, observation]);
const outcome = (o: Owner, run: string, surface: string, result: string, reason: string, count: number) =>
  o.run(`INSERT INTO source.run_surface_outcome (run_id, surface, outcome, reason, capture_count,
    capture_set_digest, detail) VALUES ($1,$2,$3,$4,$5,$6,'{}')`,
  [run, surface, result, reason, count, count ? sha(`${run}:${surface}`) : null]);
const complete = (o: Owner, run: string, result: string) => o.run(`INSERT INTO source.acquisition_run_completion
  (run_id, outcome, qualified_count, unqualified_count, failed_count, missing_count)
  VALUES ($1,$2,0,0,0,0) RETURNING *`, [run, result]);

async function completedRun(o: Owner, principal: string) {
  const run = await createRun(o, principal, [{ surface: 'dump' }]);
  await capture(o, run, 'dump', await o.observation(await o.record(), principal), 0);
  await outcome(o, run, 'dump', 'qualified', 'complete', 1);
  await complete(o, run, 'completed');
  return run;
}

test('LIVE01/LIVE02/LIVE06: source run, field and identity schema installs empty and upgrades from head', async () => {
  // The stack runner accepts the reserved range after the existing Content history.
  await migrateContent(pool);
  const versions = (await pool.query('SELECT version FROM content.schema_migration ORDER BY version'))
    .rows.map(row => row.version as number);
  expect(versions).toEqual(expect.arrayContaining([40, 41, 42, 43, 44]));
  for (const table of TABLES) {
    expect((await pool.query('SELECT to_regclass($1) AS name', [`source.${table}`])).rows[0]?.name).not.toBeNull();
  }

  const empty = owner('empty');
  await empty.apply([...HEAD, ...NEW]);
  for (const table of TABLES) {
    expect((await empty.run(`SELECT count(*)::int AS total FROM source.${table}`)).rows[0]?.total).toBe(0);
  }

  // Upgrade: bind legacy source rows at the 021 head, then apply the new range.
  const o = owner('upgrade');
  await o.apply(HEAD);
  const principal = randomUUID();
  const recordId = await o.record('open-library', 'work');
  const observationId = await o.observation(recordId, principal);
  const conversion = randomUUID();
  const legacyConversion = (id: string, observation: string) => o.run(`INSERT INTO source.conversion (id,
    observation_id, principal_id, mapping_revision, source_digest, projection, field_inventory)
    VALUES ($1,$2,$3,'open-library-work-map-v1',$4,'{}','[{"field":"title","disposition":"candidate-fact"}]')`,
  [id, observation, principal, 'a'.repeat(64)]);
  await legacyConversion(conversion, observationId);
  const second = randomUUID();
  await legacyConversion(second, await o.observation(recordId, principal));
  const correspondence = (field: string) => o.run(`INSERT INTO source.child_correspondence (id, principal_id,
    record_id, base_conversion_id, candidate_conversion_id, field, base_occurrence, candidate_occurrence,
    base_ordinal, candidate_ordinal, source_key, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,1,'/authors/OL1A',$9)`,
  [randomUUID(), principal, recordId, conversion, second, field, `urn:rezics:source-occurrence:${sha(field)}`,
    `urn:rezics:source-occurrence:${sha(`${field}:c`)}`, `pair-${randomUUID()}`]);
  await correspondence('authors');
  await expect(correspondence('tracks')).rejects.toMatchObject({ code: '23514' });
  const before = (await o.run(`SELECT to_jsonb(c) AS row FROM source.conversion c ORDER BY id`)).rows;

  await o.apply(NEW);
  expect((await o.run(`SELECT to_jsonb(c) AS row FROM source.conversion c ORDER BY id`)).rows).toEqual(before);
  await legacyConversion(randomUUID(), await o.observation(recordId, principal));
  await correspondence('tracks');
  await expect(o.run(`INSERT INTO source.conversion (id, observation_id, principal_id, mapping_revision,
    source_digest, projection, field_inventory) VALUES ($1,$2,$3,'unregistered-map-v1',$4,'{}','[]')`,
  [randomUUID(), await o.observation(recordId, principal), principal, 'a'.repeat(64)]))
    .rejects.toMatchObject({ constraint: 'conversion_field_inventory' });
  await expect(o.run('UPDATE source.conversion SET principal_id = $1', [randomUUID()])).rejects.toThrow('immutable');
}, 30_000);

test('LIVE02/LIVE09/LIVE11/LIVE16: frozen run captures, retention terms and derived completion receipt', async () => {
  const o = owner('run');
  await o.apply([...HEAD, ...NEW]);
  const principal = randomUUID();

  // Surfaces are frozen with the run: a short or late surface set fails.
  await expect(createRun(o, principal, [{ surface: 'work' }], 2))
    .rejects.toMatchObject({ constraint: 'acquisition_run_surfaces_frozen' });
  const run = await createRun(o, principal, [
    { surface: 'work' },
    { surface: 'ratings', requested: 'retained', terms: 'prohibited' },
    { surface: 'editions', limit: 1 },
    { surface: 'covers', required: false },
  ]);
  await expect(o.run(`INSERT INTO source.acquisition_run_surface (run_id, surface, ordinal, required, capture_limit,
    requested_retention, retention_terms, terms_reference) VALUES ($1,'late',9,true,1,'retained','permitted','t')`, [run]))
    .rejects.toMatchObject({ constraint: 'acquisition_run_surfaces_frozen' });
  const ratings = (await o.run(`SELECT effective_retention, retention_limited FROM source.acquisition_run_surface
    WHERE run_id = $1 AND surface = 'ratings'`, [run])).rows[0]!;
  expect(ratings).toEqual({ effective_retention: 'not-retained', retention_limited: true });

  const workRecord = await o.record();
  await capture(o, run, 'work', await o.observation(workRecord, principal), 0, 'GET /works/1');
  // One capture per request per run: consumers reuse it instead of refetching.
  await expect(capture(o, run, 'work', await o.observation(workRecord, principal), 1, 'GET /works/1'))
    .rejects.toMatchObject({ code: '23505' });
  // Terms prohibiting retention cannot be widened by a reproduction request.
  await expect(capture(o, run, 'ratings', await o.observation(workRecord, principal), 0))
    .rejects.toMatchObject({ constraint: 'run_capture_observation' });
  await capture(o, run, 'ratings', await o.observation(workRecord, principal, 'not-retained'), 0);
  await expect(capture(o, run, 'work', await o.observation(workRecord, randomUUID()), 2))
    .rejects.toMatchObject({ constraint: 'run_capture_observation' });
  await expect(capture(o, run, 'work', await o.observation(await o.record('other-provider'), principal), 2))
    .rejects.toMatchObject({ constraint: 'run_capture_observation' });
  await capture(o, run, 'editions', await o.observation(workRecord, principal), 0);
  await expect(capture(o, run, 'editions', await o.observation(workRecord, principal), 1))
    .rejects.toMatchObject({ constraint: 'run_capture_budget' });

  await expect(outcome(o, run, 'work', 'qualified', 'complete', 2))
    .rejects.toMatchObject({ constraint: 'run_surface_outcome_captures' });
  await expect(outcome(o, run, 'work', 'qualified', 'network', 1)).rejects.toMatchObject({ code: '23514' });
  await expect(outcome(o, run, 'covers', 'qualified', 'complete', 0)).rejects.toMatchObject({ code: '23514' });
  await outcome(o, run, 'work', 'qualified', 'complete', 1);
  await expect(capture(o, run, 'work', await o.observation(workRecord, principal), 3))
    .rejects.toMatchObject({ constraint: 'run_capture_frozen' });
  await outcome(o, run, 'ratings', 'qualified', 'complete', 1);
  // Provider access limits are recorded, never an empty qualified surface (LIVE11).
  await outcome(o, run, 'editions', 'unqualified', 'authentication-required', 1);
  await expect(complete(o, run, 'incomplete')).rejects.toMatchObject({ constraint: 'acquisition_run_completion_outcome' });
  await expect(complete(o, run, 'completed')).rejects.toMatchObject({ constraint: 'acquisition_run_completion_outcome' });
  const abandoned = (await complete(o, run, 'abandoned')).rows[0]!;
  expect(abandoned).toMatchObject({ qualified_count: 2, unqualified_count: 1, failed_count: 0, missing_count: 1 });
  await expect(outcome(o, run, 'covers', 'failed', 'timeout', 0)).rejects.toMatchObject({ constraint: 'run_capture_frozen' });

  // A failed required surface leaves only an incomplete receipt (LIVE02).
  const failed = await createRun(o, principal, [{ surface: 'work' }, { surface: 'covers', required: false }]);
  await outcome(o, failed, 'work', 'failed', 'malformed', 0);
  await outcome(o, failed, 'covers', 'failed', 'network', 0);
  await expect(complete(o, failed, 'completed')).rejects.toMatchObject({ constraint: 'acquisition_run_completion_outcome' });
  expect((await complete(o, failed, 'incomplete')).rows[0]).toMatchObject({ failed_count: 2, missing_count: 0 });
  // An optional surface failure does not block a completed receipt.
  const optional = await createRun(o, principal, [{ surface: 'work' }, { surface: 'covers', required: false }]);
  await capture(o, optional, 'work', await o.observation(workRecord, principal), 0);
  await outcome(o, optional, 'work', 'qualified', 'complete', 1);
  await outcome(o, optional, 'covers', 'unqualified', 'terms-restricted', 0);
  expect((await complete(o, optional, 'completed')).rows[0]).toMatchObject({ qualified_count: 1, unqualified_count: 1 });

  // A concurrent capture and outcome serialize on the surface row; an outcome always
  // counts the exact committed capture set.
  for (let attempt = 0; attempt < 4; attempt++) {
    const race = await createRun(o, principal, [{ surface: 'work' }]);
    const observation = await o.observation(workRecord, principal);
    const [added, closed] = await Promise.allSettled([capture(o, race, 'work', observation, 0),
      outcome(o, race, 'work', 'failed', 'timeout', 0)]);
    const captured = (await o.run('SELECT count(*)::int AS total FROM source.run_capture WHERE run_id = $1', [race]))
      .rows[0]!.total;
    expect(added.status === 'fulfilled' && closed.status === 'fulfilled').toBe(false);
    if (closed.status === 'fulfilled') expect(captured).toBe(0);
  }
  await expect(o.run('DELETE FROM source.run_capture WHERE run_id = $1', [run])).rejects.toThrow('immutable');
  await expect(o.run('UPDATE source.acquisition_run_completion SET outcome = $2 WHERE run_id = $1',
    [run, 'completed'])).rejects.toThrow('immutable');

  // Bulk-built owner growth: run receipt and surface/outcome reads stay indexed.
  for (const size of [64, 512]) {
    await o.tx(async query => {
      await query(`INSERT INTO source.acquisition_run (id, principal_id, provider, profile, surface_count,
        idempotency_key, request_digest) SELECT gen_random_uuid(), gen_random_uuid(), 'fixture', 'fixture-run-v1', 1,
        'bulk-' || $1 || '-' || n, repeat('b', 64) FROM generate_series(1, $1::int) n`, [size]);
      await query(`INSERT INTO source.acquisition_run_surface (run_id, surface, ordinal, required, capture_limit,
        requested_retention, retention_terms, terms_reference) SELECT id, 'work', 0, true, 1, 'retained', 'permitted', 't'
        FROM source.acquisition_run WHERE idempotency_key LIKE 'bulk-' || $1 || '-%'`, [size]);
    });
    await o.run('ANALYZE source.acquisition_run');
    await o.run('ANALYZE source.acquisition_run_surface');
    const plan = (await o.run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
      SELECT r.id, s.surface, x.outcome, c.outcome FROM source.acquisition_run r
      JOIN source.acquisition_run_surface s ON s.run_id = r.id
      LEFT JOIN source.run_surface_outcome x ON x.run_id = s.run_id AND x.surface = s.surface
      LEFT JOIN source.acquisition_run_completion c ON c.run_id = r.id
      WHERE r.principal_id = $1 AND r.idempotency_key = $2`, [principal, `run-${run}`])).rows[0]!['QUERY PLAN'][0].Plan;
    expect(plan['Actual Rows']).toBe(4);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(48);
    expect(plan['Temp Read Blocks']).toBe(0);
  }
}, 60_000);

test('LIVE12: feed checkpoints derive overlap and gaps, resume from the durable head and close gaps', async () => {
  const o = owner('feed');
  await o.apply([...HEAD, ...NEW]);
  const principal = randomUUID();
  const feed = randomUUID();
  await o.run(`INSERT INTO source.feed (id, principal_id, provider, namespace, feed_key, position_scheme, max_page_items)
    VALUES ($1,$2,'fixture','work','changes','provider-sequence',100)`, [feed, principal]);
  const head = async () => (await o.run('SELECT * FROM source.feed_head WHERE feed_id = $1', [feed])).rows[0]!;
  const stream = await createRun(o, principal, [{ surface: 'changes', limit: 4096 }]);
  let ordinal = 0;
  const page = async () => (await capture(o, stream, 'changes',
    await o.observation(await o.record(), principal), ordinal++)).rows[0]!.id as string;
  const checkpoint = async (kind: string, continuity: string, from: number, to: number,
    options: { run?: string; capture?: string | null; items?: number; closes?: string; predecessor?: string | null } = {}) => {
    const current = await head();
    const id = randomUUID();
    await o.run(`INSERT INTO source.feed_checkpoint (id, feed_id, seq, predecessor_id, kind, run_id, capture_id,
      from_position, to_position, resume_token, item_count, continuity, closes_gap_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, feed, current.seq + 1, options.predecessor === undefined ? current.checkpoint_id : options.predecessor, kind,
      options.run ?? stream, options.capture === undefined ? (kind === 'baseline' ? null : await page()) : options.capture,
      from, to, `token-${to}`, options.items ?? 10, continuity, options.closes ?? null]);
    return id;
  };

  await expect(checkpoint('change', 'contiguous', 0, 10)).rejects.toMatchObject({ code: '23514' });
  const partial = await createRun(o, principal, [{ surface: 'dump' }]);
  await outcome(o, partial, 'dump', 'failed', 'oversized', 0);
  await complete(o, partial, 'incomplete');
  await expect(checkpoint('baseline', 'baseline', 0, 100, { run: partial }))
    .rejects.toMatchObject({ constraint: 'feed_checkpoint_baseline' });
  await checkpoint('baseline', 'baseline', 0, 100, { run: await completedRun(o, principal) });
  expect(await head()).toMatchObject({ seq: 1, position: '100' });

  // Deliberate overlap is derived, not caller-labelled; items at or below the head dedupe.
  await expect(checkpoint('change', 'contiguous', 90, 150)).rejects.toMatchObject({ constraint: 'feed_checkpoint_continuity' });
  await checkpoint('change', 'overlap', 90, 150);
  await checkpoint('change', 'contiguous', 151, 200);
  await expect(checkpoint('change', 'contiguous', 201, 210, { items: 101 })).rejects.toMatchObject({ constraint: 'feed_checkpoint_run' });
  const other = await createRun(o, principal, [{ surface: 'changes' }]);
  const foreignPage = (await capture(o, other, 'changes', await o.observation(await o.record(), principal), 0)).rows[0]!.id;
  await expect(checkpoint('change', 'contiguous', 201, 210, { capture: foreignPage }))
    .rejects.toMatchObject({ constraint: 'feed_checkpoint_run' });
  const gap = await checkpoint('change', 'gap', 260, 300);
  expect((await o.run('SELECT gap_from, gap_to FROM source.feed_open_gap WHERE feed_id = $1', [feed])).rows)
    .toEqual([{ gap_from: '201', gap_to: '259' }]);
  expect(await head()).toMatchObject({ seq: 4, position: '300', checkpoint_id: gap });

  // Resume extends only the durable head; two consumers racing from one head cannot fork it.
  const stale = (await head()).checkpoint_id as string;
  const [firstPage, secondPage] = [await page(), await page()];
  const racers = await Promise.allSettled([
    checkpoint('change', 'contiguous', 301, 320, { capture: firstPage, predecessor: stale }),
    checkpoint('change', 'contiguous', 301, 320, { capture: secondPage, predecessor: stale })]);
  expect(racers.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  await expect(checkpoint('change', 'contiguous', 321, 330, { predecessor: stale }))
    .rejects.toMatchObject({ constraint: 'feed_checkpoint_head' });

  await expect(checkpoint('reconciliation', 'reconciled', 210, 259, { closes: gap }))
    .rejects.toMatchObject({ constraint: 'feed_checkpoint_reconciliation' });
  await checkpoint('reconciliation', 'reconciled', 201, 259, { closes: gap });
  expect((await o.run('SELECT count(*)::int AS total FROM source.feed_open_gap WHERE feed_id = $1', [feed])).rows[0]!.total).toBe(0);
  expect(await head()).toMatchObject({ seq: 6, position: '320' });
  await checkpoint('change', 'gap', 400, 410);
  await checkpoint('change', 'gap', 500, 510);
  await checkpoint('baseline', 'baseline', 0, 505, { run: await completedRun(o, principal) });
  expect((await o.run('SELECT count(*)::int AS total FROM source.feed_open_gap WHERE feed_id = $1', [feed])).rows[0]!.total).toBe(0);
  expect(await head()).toMatchObject({ position: '505' });
  const resume = (await o.run(`SELECT c.resume_token, h.position FROM source.feed_head h
    JOIN source.feed_checkpoint c ON c.id = h.checkpoint_id WHERE h.feed_id = $1`, [feed])).rows[0]!;
  expect(resume).toEqual({ resume_token: 'token-505', position: '505' });
  await expect(o.run('UPDATE source.feed_checkpoint SET to_position = 1 WHERE feed_id = $1', [feed])).rejects.toThrow('immutable');
}, 60_000);

test('LIVE01/LIVE03/LIVE04/LIVE05/LIVE06/LIVE07/LIVE08: sealed dispositions, general supports and provider identity', async () => {
  const o = owner('field');
  await o.apply([...HEAD, ...NEW]);
  const principal = randomUUID();
  const mapping = async (revision: string, count: number, fields: Array<[string, string, string, string | null, string | null]>) =>
    o.tx(async query => {
      await query(`INSERT INTO source.field_mapping (mapping_revision, provider, namespace, root_grain, field_count)
        VALUES ($1,'fixture','work','work',$2)`, [revision, count]);
      for (const [field, disposition, kind, target, loss] of fields) {
        await query(`INSERT INTO source.field_disposition (mapping_revision, grain, field_key, disposition,
          value_kind, reason, native_target, loss) VALUES ($1,'work',$2,$3,$4,'Reviewed mapping',$5,$6)`,
        [revision, field, disposition, kind, target, loss]);
      }
    });
  const description = 'work-metadata-v1#description:en';
  await expect(mapping('fixture-work-map-v1', 3, [['title', 'native', 'language-text', 'work-metadata-v1#title:en', null]]))
    .rejects.toMatchObject({ constraint: 'field_mapping_sealed' });
  await expect(mapping('fixture-work-map-v1', 1, [['rating', 'native', 'statistic', 'rating-v1#score', null]]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(mapping('fixture-work-map-v1', 1, [['reviewer', 'lossy', 'provider-account', 'agent-v1#name', 'drops id']]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(mapping('fixture-work-map-v1', 1, [['published', 'lossy', 'time', 'work-metadata-v1#date', null]]))
    .rejects.toMatchObject({ code: '23514' });
  await expect(mapping('open-library-work-map-v1', 1, [['title', 'excluded', 'text', null, null]]))
    .rejects.toMatchObject({ code: '23514' });
  await mapping('fixture-work-map-v1', 5, [
    ['description', 'native', 'language-text', description, null],
    ['published', 'lossy', 'time', 'work-metadata-v1#first-published', 'Day precision below the native year grain'],
    ['rating', 'structured-source-only', 'statistic', null, null],
    ['subtitle', 'structured-source-only', 'language-text', null, null],
    ['tracks', 'structured-source-only', 'structure', null, null]]);
  await expect(o.run(`INSERT INTO source.field_disposition (mapping_revision, grain, field_key, disposition, value_kind,
    reason) VALUES ('fixture-work-map-v1','work','late','excluded','text','Late')`))
    .rejects.toMatchObject({ constraint: 'field_mapping_sealed' });

  const convert = async (recordId: string, inventory: unknown[]) => {
    const id = randomUUID();
    await o.run(`INSERT INTO source.conversion (id, observation_id, principal_id, mapping_revision, source_digest,
      projection, field_inventory) VALUES ($1,$2,$3,'fixture-work-map-v1',$4,'{}',$5)`,
    [id, await o.observation(recordId, principal), principal, 'c'.repeat(64), JSON.stringify(inventory)]);
    return id;
  };
  const recordA = await o.record();
  const recordB = await o.record();
  const inventory = [{ grain: 'work', field: 'description', disposition: 'native' },
    { grain: 'work', field: 'rating', disposition: 'structured-source-only' },
    { grain: 'work', field: 'x_new', disposition: 'unsupported', reason: 'undeclared-field' }];
  await expect(convert(recordA, [{ grain: 'work', field: 'rating', disposition: 'native' }]))
    .rejects.toMatchObject({ constraint: 'conversion_field_inventory' });
  await expect(convert(recordA, [{ grain: 'work', field: 'x_new', disposition: 'unsupported' }]))
    .rejects.toMatchObject({ constraint: 'conversion_field_inventory' });
  await expect(convert(recordA, [inventory[0], inventory[0]])).rejects.toMatchObject({ constraint: 'conversion_field_inventory' });
  const conversionA = await convert(recordA, inventory);
  const conversionB = await convert(recordB, inventory);

  const target = iri();
  const support = async (recordId: string, slot = description, work = target) => (await o.run(
    `INSERT INTO source.field_support (id, principal_id, target, slot, context, record_id)
      VALUES ($1,$2,$3,$4,'global',$5) RETURNING id`, [randomUUID(), principal, work, slot, recordId])).rows[0]!.id as string;
  await expect(support(recordA, 'work-metadata-v1#title:en')).rejects.toMatchObject({ code: '23514' });
  await expect(support(recordA, 'work-author-credit-v1#credit')).rejects.toMatchObject({ code: '23514' });
  const supportA = await support(recordA);
  await expect(support(recordA)).rejects.toMatchObject({ code: '23505' });
  const head = async (id: string) => (await o.run('SELECT * FROM source.field_support_head WHERE support_id = $1', [id])).rows[0]!;
  const step = (supportId: string, ordinal: number, action: string, conversion: string,
    field = 'description', control: Record<string, unknown> | null = null) => {
    const expected = iri();
    const subject = iri();
    return o.run(`INSERT INTO source.field_support_step (id, support_id, ordinal, principal_id, action, conversion_id,
      mapping_revision, grain, source_field, value_digest, expected_head, control_intent, acting_subject,
      authority_proof, native_idempotency_key, idempotency_key, request_digest)
      VALUES ($1,$2,$3,$4,$5,$6,'fixture-work-map-v1','work',$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [randomUUID(), supportId, ordinal, principal, action, conversion, field, 'd'.repeat(64), expected,
      action === 'attach' ? null : JSON.stringify(control ?? { contentHead: expected, controlHead: null,
        controlEpoch: 0, protectionHead: null }), subject, JSON.stringify({ principalId: principal, actingSubject: subject }),
      action === 'attach' ? null : `source-field-${randomUUID()}`, `step-${randomUUID()}`, 'e'.repeat(64)]);
  };
  const settle = (stepId: string, result: string) => o.run(`INSERT INTO source.field_support_outcome (step_id, outcome,
    native_revision, graph_receipt, admission_id, data_epoch, sequence, head_guarantee, receipt)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}')`, [stepId, result, result === 'not-applied' ? null : iri(),
    result === 'attached' ? null : `urn:rezics:receipt:${sha(stepId)}`, result === 'attached' ? null : randomUUID(),
    result === 'attached' ? null : randomUUID(), result === 'attached' ? null : 7,
    result === 'attached' ? 'verified-before-commit' : 'transaction-guarded']);
  const withdraw = (supportId: string, expected: string | null) => o.run(`INSERT INTO source.field_support_withdrawal
    (id, support_id, principal_id, expected_step_id, idempotency_key, reason) VALUES ($1,$2,$3,$4,$5,'Explicit disposition')`,
  [randomUUID(), supportId, principal, expected, `withdraw-${randomUUID()}`]);

  // Only a declared native/lossy field of the support's own record can support the slot.
  await expect(step(supportA, 1, 'apply', conversionB)).rejects.toMatchObject({ constraint: 'field_support_source' });
  await expect(step(supportA, 1, 'apply', conversionA, 'subtitle')).rejects.toMatchObject({ constraint: 'field_support_source' });
  await expect(step(supportA, 1, 'apply', conversionA, 'description', { contentHead: iri() })).rejects.toMatchObject({ code: '23514' });
  await expect(step(supportA, 2, 'apply', conversionA)).rejects.toMatchObject({ constraint: 'field_support_sequence' });
  await expect(step(supportA, 1, 'return-control', conversionA)).rejects.toMatchObject({ constraint: 'field_support_sequence' });
  const first = (await step(supportA, 1, 'apply', conversionA)).rows[0]!.id as string;
  await expect(step(supportA, 2, 'apply', conversionA)).rejects.toMatchObject({ constraint: 'field_support_settled' });
  await expect(withdraw(supportA, null)).rejects.toMatchObject({ constraint: 'field_support_settled' });
  await expect(settle(first, 'attached')).rejects.toMatchObject({ constraint: 'field_support_outcome_pending' });
  // A human control takeover makes the native CAS reject the source write (LIVE03).
  await settle(first, 'not-applied');
  expect(await head(supportA)).toMatchObject({ step_count: 1, settled_step_id: null, pending_step_id: null });
  const racers = await Promise.allSettled([step(supportA, 2, 'apply', conversionA), step(supportA, 2, 'apply', conversionA)]);
  expect(racers.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const applied = (racers.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<QueryResult>).value.rows[0]!.id;
  await settle(applied, 'applied');
  await expect(settle(applied, 'applied')).rejects.toMatchObject({ constraint: 'field_support_outcome_pending' });

  // A second source record is an independent support; withdrawing one leaves the other (LIVE05).
  const supportB = await support(recordB);
  const attach = (await step(supportB, 1, 'attach', conversionB)).rows[0]!.id as string;
  await settle(attach, 'attached');
  await expect(withdraw(supportA, null)).rejects.toMatchObject({ constraint: 'field_support_exact' });
  await withdraw(supportA, applied);
  await expect(step(supportA, 3, 'apply', conversionA)).rejects.toMatchObject({ constraint: 'field_support_active' });
  expect(await head(supportB)).toMatchObject({ settled_step_id: attach, pending_step_id: null });
  await expect(o.run('DELETE FROM source.field_support_withdrawal WHERE support_id = $1', [supportA])).rejects.toThrow('immutable');

  // A provider redirect is observation-backed source evidence that proposes, never
  // transfers, native identity; existing supports keep their record (LIVE06).
  const recordC = await o.record();
  const change = async (from: string, to: string, observation: string, id = randomUUID()) => {
    await o.run(`INSERT INTO source.record_identity_change (id, principal_id, kind, from_record_id, to_record_id,
      observation_id) VALUES ($1,$2,'redirect',$3,$4,$5)`, [id, principal, from, to, observation]);
    return id;
  };
  await expect(change(recordA, recordC, await o.observation(recordA, randomUUID())))
    .rejects.toMatchObject({ constraint: 'record_identity_change_evidence' });
  await expect(change(recordA, await o.record('fixture', 'edition'), await o.observation(recordA, principal)))
    .rejects.toMatchObject({ constraint: 'record_identity_change_evidence' });
  await expect(change(recordA, recordC, await o.observation(recordB, principal)))
    .rejects.toMatchObject({ constraint: 'record_identity_change_evidence' });
  const snapshot = async () => (await o.run(`SELECT s.id, s.record_id, s.target, h.settled_step_id
    FROM source.field_support s JOIN source.field_support_head h ON h.support_id = s.id ORDER BY s.id`)).rows;
  const beforeRedirect = await snapshot();
  const redirect = await change(recordA, recordC, await o.observation(recordA, principal));
  const otherTarget = iri();
  const propose = (from: string, to: string) => o.run(`INSERT INTO source.identity_correction_proposal (id,
    principal_id, change_id, from_target, to_target, effect, idempotency_key, request_digest)
    VALUES ($1,$2,$3,$4,$5,'proposal-only',$6,$7)`,
  [randomUUID(), principal, redirect, from, to, `identity-${randomUUID()}`, 'f'.repeat(64)]);
  await expect(propose(target, otherTarget)).rejects.toMatchObject({ constraint: 'identity_correction_supports' });
  await support(recordC, description, otherTarget);
  await propose(target, otherTarget);
  await expect(propose(target, otherTarget)).rejects.toMatchObject({ code: '23505' });
  const afterRedirect = (await snapshot()).filter(row => row.record_id !== recordC);
  expect(afterRedirect).toEqual(beforeRedirect);
  // A redirect cannot route the redirected record's evidence into the new record's support.
  const supportC = (await o.run('SELECT id FROM source.field_support WHERE record_id = $1', [recordC])).rows[0]!.id;
  await expect(step(supportC, 1, 'attach', conversionA)).rejects.toMatchObject({ constraint: 'field_support_source' });

  // Bulk-built support growth keeps the slot read indexed.
  await o.run(`INSERT INTO source.field_support (id, principal_id, target, slot, context, record_id)
    SELECT gen_random_uuid(), gen_random_uuid(), 'https://rezics.com/id/' || gen_random_uuid(), $1, 'global', $2
    FROM generate_series(1, 512)`, [description, recordA]);
  await o.run('ANALYZE source.field_support');
  await o.run('ANALYZE source.field_support_head');
  const plan = (await o.run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
    SELECT s.id, h.settled_step_id, h.pending_step_id, w.id FROM source.field_support s
    JOIN source.field_support_head h ON h.support_id = s.id
    LEFT JOIN source.field_support_withdrawal w ON w.support_id = s.id
    WHERE s.target = $1 AND s.slot = $2 AND s.context = 'global'`, [target, description])).rows[0]!['QUERY PLAN'][0].Plan;
  expect(plan['Actual Rows']).toBe(2);
  expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(48);
  expect(plan['Temp Read Blocks']).toBe(0);
}, 60_000);
