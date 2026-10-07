import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import {
  boundedPool,
  NestedPoolCheckoutError,
  nestedPoolCheckoutMode,
  setNestedPoolCheckoutMode,
} from '../src/infrastructure/pg-pool.ts';
import { automaticDiscovery } from '../src/modules/discovery/automation.ts';
import type { ProjectedWork } from '../src/modules/discovery/contract.ts';
import {
  DiscoveryRefreshStore,
  DISCOVERY_REFRESH_COST,
} from '../src/modules/discovery/refresh-store.ts';
import { DiscoveryProjection, discoveryScopeKey } from '../src/modules/discovery/store.ts';
import {
  fenceLease,
  inAccess,
  markFailed,
  RecommendationStale,
  RecommendationUnavailable,
} from '../src/modules/recommendation/derived-generation.ts';

const root = resolve(import.meta.dir, '../../..');
const state = join(root, '.temp', `discovery-nested-checkout-${randomUUID()}`);
const data = join(state, 'pgdata');
const position = { dataEpoch: randomUUID(), sequence: '1' };
const basis = { scope: 'global' as const, realm: null, context: null, owner: null };
const scopeKey = discoveryScopeKey(basis);
const operator = automaticDiscovery(null);
const native = () => `https://rezics.com/id/${randomUUID()}`;
const work: ProjectedWork = {
  work: native(),
  revision: native(),
  mainVersion: native(),
  types: [],
  recentOrder: '1',
  rating: null,
  primaryCredits: [],
  classifications: [{ sense: native(), concept: native(), decision: native(), source: 'global' }],
};
const replacement: ProjectedWork = {
  ...work,
  revision: native(),
  classifications: [{ sense: native(), concept: native(), decision: native(), source: 'global' }],
};
const receipt = () => ({ idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
const previousMode = nestedPoolCheckoutMode();
let port: number;
let admin: Pool;
let access: Pool;
let refresh: DiscoveryRefreshStore;
let projection: DiscoveryProjection;
let rootId: string;
let deltaId: string;
let lease: string;
let database: string;
let copies = 0;
let started = false;

beforeAll(async () => {
  setNestedPoolCheckoutMode('throw');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], {
    cwd: state,
    stdio: 'pipe',
  });
  port = await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string')
        return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
  execFileSync(
    'pg_ctl',
    [
      '-D',
      data,
      '-l',
      join(state, 'postgres.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -k /tmp`,
      '-w',
      'start',
    ],
    { cwd: state, stdio: 'pipe' },
  );
  started = true;
  const config = { host: '127.0.0.1', port, user: process.env.USER, max: 1 };
  admin = new Pool({ ...config, database: 'postgres' });
  await admin.query('CREATE DATABASE discovery_baseline');
  const baseline = boundedPool({ ...config, database: 'discovery_baseline' });
  try {
    await inAccess(baseline, async (client) => {
      for (const file of schemaFiles(root, 'access'))
        await client.query(
          readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'),
        );
    });
    const builds = new DiscoveryProjection(baseline);
    rootId = (await builds.register(operator, basis, position, receipt())).generation_id;
    const first = await builds.beginStep(operator, rootId, '');
    await builds.commitBatch(
      operator,
      rootId,
      first.lease,
      '',
      { after: work.work, complete: true, items: [work] },
      position,
    );
    await builds.activate(operator, rootId, null, position, receipt());
    deltaId = (
      await builds.register(operator, basis, position, receipt(), {
        generation: rootId,
        works: [work.work],
      })
    ).generation_id;
    lease = (await builds.beginStep(operator, deltaId, '')).lease;
    // Replacing this Work stages new postings/counters and retires old ones while the
    // ready root continues to expose its original immutable snapshot.
    await builds.commitBatch(
      operator,
      deltaId,
      lease,
      '',
      { after: work.work, complete: false, items: [replacement] },
      position,
    );
    await inAccess(baseline, async (client) => {
      await client.query(
        `INSERT INTO access.discovery_refresh
        (scope_key,basis,generation_id,lease_epoch,due_at)
        VALUES ($1,$2,$3,7,clock_timestamp()+interval '1 hour')
        ON CONFLICT (scope_key) DO UPDATE SET generation_id=EXCLUDED.generation_id,
          lease_epoch=EXCLUDED.lease_epoch,due_at=EXCLUDED.due_at`,
        [scopeKey, basis, deltaId],
      );
    });
  } finally {
    await baseline.end();
  }
}, 60_000);

beforeEach(async () => {
  // Copy one consistent owner fixture; each failure/retry case owns its data.
  database = `discovery_copy_${++copies}`;
  await admin.query(`CREATE DATABASE ${database} TEMPLATE discovery_baseline`);
  access = boundedPool({
    host: '127.0.0.1',
    port,
    user: process.env.USER,
    database,
    max: 1,
    connectionTimeoutMillis: 500,
  });
  refresh = new DiscoveryRefreshStore(access);
  projection = new DiscoveryProjection(access);
}, 30_000);

afterEach(async () => {
  await access?.end();
  if (database) await admin.query(`DROP DATABASE ${database}`);
}, 30_000);

afterAll(async () => {
  await admin?.end();
  if (started)
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state, stdio: 'pipe' });
  rmSync(state, { recursive: true, force: true });
  setNestedPoolCheckoutMode(previousMode);
}, 60_000);

async function dueRetirement() {
  await inAccess(access, (client) => markFailed(client, deltaId, lease, 'interrupted-build'));
  await access.query(
    `UPDATE access.derived_generation
    SET finished_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
    [deltaId],
  );
  await access.query(
    `UPDATE access.discovery_retirement
    SET due_at=clock_timestamp()-interval '1 second' WHERE generation_id=$1`,
    [deltaId],
  );
}

async function snapshot() {
  const rows = await access.query<{ snapshot: unknown }>(`SELECT jsonb_build_object(
    'generations',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM access.derived_generation g),
    'discovery',(SELECT jsonb_agg(to_jsonb(d) ORDER BY generation_id) FROM access.discovery_generation d),
    'retirement',(SELECT jsonb_agg(to_jsonb(r) ORDER BY generation_id) FROM access.discovery_retirement r),
    'refresh',(SELECT jsonb_agg(to_jsonb(j) ORDER BY scope_key) FROM access.discovery_refresh j),
    'entries',(SELECT jsonb_agg(to_jsonb(e) ORDER BY work,term,entry_version) FROM access.discovery_entry e),
    'terms',(SELECT jsonb_agg(to_jsonb(t) ORDER BY term,entry_version) FROM access.discovery_term_count t),
    'concepts',(SELECT jsonb_agg(to_jsonb(c) ORDER BY concept,entry_version) FROM access.discovery_concept_count c),
    'heads',(SELECT jsonb_agg(to_jsonb(h) ORDER BY scope_key) FROM access.derived_generation_head h)
  ) AS snapshot`);
  return rows.rows[0]!.snapshot;
}

test('the one-client detector rejects nested checkout and standalone transactions remain bounded', async () => {
  await inAccess(access, async (client) => {
    await expect(access.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    const settings = await client.query(`SELECT current_setting('lock_timeout') AS lock,
      current_setting('statement_timeout') AS statement`);
    expect(settings.rows).toEqual([{ lock: '2s', statement: '5s' }]);
  });
  const before = await snapshot();
  await expect(
    inAccess(access, async (client) => {
      await markFailed(client, deltaId, lease, 'interrupted-build');
      throw new RecommendationStale('retry this transaction');
    }),
  ).rejects.toThrow('retry this transaction');
  expect(await snapshot()).toEqual(before);
  await dueRetirement();
  expect(
    (
      await access.query(
        'SELECT state,lease_epoch::text FROM access.derived_generation WHERE id=$1',
        [deltaId],
      )
    ).rows,
  ).toEqual([{ state: 'failed', lease_epoch: lease }]);
  expect(access.totalCount).toBe(1);
});

test('purge rolls back version repair and retirement bookkeeping together, then retries without repeated faults', async () => {
  await dueRetirement();
  await access.query(`CREATE FUNCTION access.interrupt_discovery_purge() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'interrupted purge' USING ERRCODE='40001'; END $$;
    CREATE TRIGGER interrupt_discovery_purge BEFORE DELETE ON access.discovery_generation
    FOR EACH ROW EXECUTE FUNCTION access.interrupt_discovery_purge()`);
  const before = await snapshot();
  await expect(refresh.purge()).rejects.toBeInstanceOf(RecommendationStale);
  expect(await snapshot()).toEqual(before);
  await access.query('DROP TRIGGER interrupt_discovery_purge ON access.discovery_generation');
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  const checkouts = spyOn(access, 'connect');
  try {
    // The helper's rollback deletes the staged version, so purge itself reports
    // no discarded retained rows. It must still finish the queue item.
    expect(await refresh.purge()).toBe(0);
    for (let tick = 0; tick < 8; tick++) expect(await refresh.purge()).toBe(0);
    expect(checkouts).toHaveBeenCalledTimes(9);
    expect(logged).not.toHaveBeenCalled();
  } finally {
    checkouts.mockRestore();
    logged.mockRestore();
  }
  expect(
    (await access.query('SELECT generation_id FROM access.discovery_retirement')).rows,
  ).toEqual([]);
  expect(
    (await access.query('SELECT generation_id,lease_epoch::text FROM access.discovery_refresh'))
      .rows,
  ).toEqual([{ generation_id: null, lease_epoch: '7' }]);
  expect(
    (
      await access.query(
        'SELECT generation_id FROM access.discovery_generation ORDER BY generation_id',
      )
    ).rows,
  ).toEqual([{ generation_id: rootId }]);
  expect(
    (
      await access.query(
        'SELECT state,lease_epoch::text,lease_expires_at FROM access.derived_generation WHERE id=$1',
        [deltaId],
      )
    ).rows,
  ).toEqual([{ state: 'failed', lease_epoch: lease, lease_expires_at: null }]);
  expect(
    (
      await access.query(
        'SELECT active_generation,revision::text FROM access.derived_generation_head',
      )
    ).rows,
  ).toEqual([{ active_generation: rootId, revision: '1' }]);
  for (const table of ['discovery_entry', 'discovery_term_count', 'discovery_concept_count']) {
    const versions = await access.query(
      `SELECT DISTINCT entry_version::text,retired_version FROM access.${table}`,
    );
    expect(versions.rows).toEqual([{ entry_version: '0', retired_version: null }]);
  }
  expect(access.totalCount).toBe(1);
  expect(access.waitingCount).toBe(0);
});

test('held recovery prevents purge and reopening permits the same retirement to finish', async () => {
  await dueRetirement();
  await access.query('UPDATE access.recovery_fence SET open=false WHERE id');
  const before = await snapshot();
  await expect(refresh.purge()).rejects.toBeInstanceOf(RecommendationUnavailable);
  expect(await snapshot()).toEqual(before);
  await access.query('UPDATE access.recovery_fence SET open=true WHERE id');
  expect(await refresh.purge()).toBe(0);
  expect((await access.query('SELECT 1 FROM access.discovery_retirement')).rows).toEqual([]);
});

test('standalone purge keeps a partial retirement queued until its bounded chunks finish', async () => {
  const separate = { ...basis, context: native() };
  const id = (await projection.register(operator, separate, position, receipt())).generation_id;
  await access.query(
    `INSERT INTO access.discovery_entry
    (generation_id,work,work_type,term,recent_order,rating_count,rating_sum,payload)
    SELECT $1,'https://rezics.com/id/'||gen_random_uuid()::text,'','',i,0,0,'{}'::jsonb
    FROM generate_series(1,$2::integer) i`,
    [id, DISCOVERY_REFRESH_COST.purgeEntries + 1],
  );
  await refresh.enroll([separate]);
  const job = (await refresh.claim())!;
  expect(job.scope_key).toBe(discoveryScopeKey(separate));
  await refresh.attach(job, id);
  await inAccess(access, (client) => markFailed(client, id, '1', 'interrupted-build'));
  await access.query(
    `UPDATE access.derived_generation
    SET finished_at=clock_timestamp()-interval '1 hour' WHERE id=$1`,
    [id],
  );
  await access.query(
    `UPDATE access.discovery_retirement
    SET due_at=clock_timestamp()-interval '1 second' WHERE generation_id=$1`,
    [id],
  );
  expect(await refresh.purge()).toBe(DISCOVERY_REFRESH_COST.purgeEntries);
  expect(
    (await access.query('SELECT generation_id FROM access.discovery_retirement')).rows,
  ).toEqual([{ generation_id: id }]);
  expect(
    (
      await access.query('SELECT generation_id FROM access.discovery_refresh WHERE scope_key=$1', [
        job.scope_key,
      ])
    ).rows,
  ).toEqual([{ generation_id: id }]);
  expect(
    (
      await access.query(
        'SELECT count(*)::text AS count FROM access.discovery_entry WHERE generation_id=$1',
        [id],
      )
    ).rows,
  ).toEqual([{ count: '1' }]);
  expect(await refresh.purge()).toBe(1);
  expect(await refresh.purge()).toBe(0);
  expect((await access.query('SELECT 1 FROM access.discovery_retirement')).rows).toEqual([]);
  expect(
    (await access.query('SELECT 1 FROM access.discovery_generation WHERE generation_id=$1', [id]))
      .rows,
  ).toEqual([]);
  expect(
    (
      await access.query(
        'SELECT generation_id,lease_epoch::text FROM access.discovery_refresh WHERE scope_key=$1',
        [job.scope_key],
      )
    ).rows,
  ).toEqual([{ generation_id: null, lease_epoch: job.lease_epoch }]);
});

test('obsolete discovery inspection reuses its transaction while stale refresh and build leases stay fenced', async () => {
  const job = { scope_key: scopeKey, basis, generation_id: deltaId, lease_epoch: '7' };
  const obsolete = { ...position, dataEpoch: randomUUID() };
  const before = await snapshot();
  await expect(refresh.inspect({ ...job, lease_epoch: '6' }, obsolete)).rejects.toThrow(
    'Refresh lease changed',
  );
  expect(await snapshot()).toEqual(before);
  const checkouts = spyOn(access, 'connect');
  try {
    expect(await refresh.inspect(job, obsolete)).toMatchObject({ fresh: false, row: null });
    expect(checkouts).toHaveBeenCalledTimes(1);
  } finally {
    checkouts.mockRestore();
  }
  expect(
    (
      await access.query(
        'SELECT state,lease_epoch::text,lease_expires_at,failure_reason FROM access.derived_generation WHERE id=$1',
        [deltaId],
      )
    ).rows,
  ).toEqual([
    {
      state: 'cancelled',
      lease_epoch: lease,
      lease_expires_at: null,
      failure_reason: 'discovery-source-changed',
    },
  ]);
  await expect(
    inAccess(access, (client) => fenceLease(client, deltaId, lease, 30_000)),
  ).rejects.toBeInstanceOf(RecommendationStale);
  await expect(
    projection.commitBatch(
      operator,
      deltaId,
      lease,
      work.work,
      { after: work.work, complete: true, items: [] },
      position,
    ),
  ).rejects.toBeInstanceOf(RecommendationStale);
  expect(
    (await access.query('SELECT generation_id FROM access.discovery_retirement')).rows,
  ).toEqual([{ generation_id: deltaId }]);
  expect(
    (
      await access.query(
        'SELECT active_generation,revision::text FROM access.derived_generation_head',
      )
    ).rows,
  ).toEqual([{ active_generation: rootId, revision: '1' }]);
});

test('Bun startup and instrumented workers release detector ownership across async contexts', async () => {
  const connection = `postgres://${process.env.USER}@127.0.0.1:${port}/${database}`;
  const results = [];
  for (const mode of ['plain', 'telemetry']) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'discovery-nested-checkout-startup.ts'),
        connection,
        mode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    results.push({ code, stderr, result: JSON.parse(stdout.trim()) });
  }
  expect(results).toEqual(
    ['plain', 'telemetry'].map((mode) => ({
      code: 0,
      stderr: '',
      result: { instrumented: mode === 'telemetry', completed: 6, failures: [] },
    })),
  );
}, 30_000);
