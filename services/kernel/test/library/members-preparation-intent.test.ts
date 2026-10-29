import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Capture } from '../support/growth.ts';
import canonicalize from 'canonicalize';
import { ProblemError } from '../../src/http/problem.ts';
import { LifecycleDeniedError } from '../../src/access/lifecycle-20261025094010-command.ts';
import { runOperationalTransaction } from '../../src/command/operational.ts';
import type { PreparingEpisode } from '../../src/library/members-preparation.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth } from '../support/growth.ts';
import { statementOccurrences } from '../support/growth-report.ts';
import {
  definition,
  membersPreparationRuntime,
  retainEpisodes,
  uniquenessRace,
} from './support/members-preparation-runtime.ts';

let native: Awaited<ReturnType<typeof membersPreparationRuntime>>;
beforeAll(async () => {
  native = await membersPreparationRuntime();
}, 120000);
afterAll(async () => {
  await native?.close();
});
const prefix = 'library:members-preparation:';
function attemptBudgets(captured: Capture) {
  // Include Core's time transaction, external Access preparation and all rollback/control SQL.
  const byBackend = new Map<number | undefined, string[]>();
  const occurrences = statementOccurrences(captured).statements;
  expect(occurrences).toHaveLength(captured.statements.length);
  for (const [index, sql] of captured.statements.entries()) {
    const backend = captured.statementBackends![index];
    expect(occurrences[index]!.backend).toBe(backend);
    const statements = byBackend.get(backend) ?? [];
    statements.push(sql);
    byBackend.set(backend, statements);
  }
  for (const statements of byBackend.values()) {
    let attempt: string[] = [];
    for (const sql of statements) {
      if (sql === 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' && attempt.length) {
        expect(attempt.length).toBeLessThanOrEqual(16);
        attempt = [];
      }
      attempt.push(sql);
    }
    expect(attempt.length).toBeLessThanOrEqual(16);
  }
}

// These are independent native requirements. Unimplemented errors are ordinary failures, never expected outcomes.
test('native Library derived-preparation admission preserves current authorization and account fencing, atomically commits exactly one locator-only intent per episode, serializes owner LRU quota, and cannot resurrect retired expired or terminal episodes', async () => {
  const f = await native.fixture();
  const before = await native.domain();
  const admitted = await capture(native.db, () => f.store.reserve(f.actor, f.collectionId, [definition()]), {
    includeBackends: true,
  });
  expect(admitted.value.episodes).toHaveLength(1);
  const episode = admitted.value.episodes[0]!;
  expect(episode.state).toBe('preparing');
  expect(episode.locator).toEqual({
    route: routeOf(f.owner.accountId)!,
    ownerAccountId: f.owner.accountId,
    collectionId: f.collectionId,
    episodeId: expect.any(String),
  });
  expect(episode.workflowId).toBe(
    `${prefix}${episode.locator.route}:${f.owner.accountId}:${episode.locator.episodeId}`,
  );
  expect(admitted.value.intent).toEqual({
    queue: 'workflows',
    workflowName: 'library.membersPreparation',
    workflowId: episode.workflowId,
    input: {
      accounts: [f.owner.accountId],
      route: episode.locator.route,
      episodes: [{ collectionId: f.collectionId, episodeId: episode.locator.episodeId }],
      cleanup: [],
    },
  });
  const saved = await native.rows(f.owner);
  expect(saved).toHaveLength(1);
  expect(saved[0]!.basis_digest).toEqual(createHash('sha256').update(saved[0]!.canonical_basis).digest());
  expect(saved[0]).toMatchObject({
    state: 'live',
    episode_id: episode.locator.episodeId,
    canonical_basis: canonicalize([
      1,
      f.owner.accountId,
      f.collectionId,
      definition().filter,
      'id',
      definition().release.digest,
    ]),
    workflow_id: episode.workflowId,
  });
  const work = await native.workflow(episode.workflowId);
  expect(work.status?.status).toBe('ENQUEUED');
  expect(work.input).toEqual(admitted.value.intent!.input);
  expect(await native.domain()).toEqual(before);
  attemptBudgets(admitted.capture);
  const sql = admitted.capture.statements;
  const writes = sql
    .map((text, index) => ({ text, backend: admitted.capture.statementBackends![index] }))
    .filter(({ text }) => /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/i.test(text));
  expect(new Set(writes.map(({ backend }) => backend)).size).toBe(1);
  expect(new Set(admitted.capture.statementBackends).size).toBe(1);
  expect(sql.some((text) => /access.account[\s\S]*FOR SHARE/i.test(text))).toBe(true);
  expect(sql.findIndex((text) => /access.account[\s\S]*FOR SHARE/i.test(text))).toBeLessThan(
    sql.findIndex((text) => /INSERT INTO library.members_preparation\b/i.test(text)),
  );
  expect(sql.filter((text) => /INSERT INTO ["\w.]*workflow_(status|input)/i.test(text))).toHaveLength(2);
  expect(native.db.pool.idleCount).toBe(native.db.pool.totalCount);
});

test('concurrent identical first requests force native contention retry and share the episode and intent; different owner namespaces stay independent', async () => {
  const f = await native.fixture();
  const second = native.db.openPool({ max: 1 });
  const barrier = uniquenessRace([native.db.pool, second]);
  await barrier.arm();
  const secondActor = await native.actor(f.owner, second);
  const raced = await capture(
    native.db,
    () =>
      Promise.all([
        f.store.reserve(f.actor, f.collectionId, [definition()]),
        native.store(second).reserve(secondActor, f.collectionId, [definition()]),
      ]),
    { includeBackends: true },
  ).finally(() => barrier.restore());
  expect(barrier.arrivals()).toBe(2);
  attemptBudgets(raced.capture);
  expect(raced.value[0].episodes).toEqual(raced.value[1].episodes);
  expect(raced.value.filter((value) => value.intent !== null)).toHaveLength(1);
  expect(raced.capture.statements.filter((sql) => sql === 'BEGIN ISOLATION LEVEL SERIALIZABLE').length).toBeGreaterThan(
    2,
  );
  expect(raced.capture.statements).toContain('ROLLBACK');
  expect(raced.capture.statementErrors?.some((error) => error === '40001')).toBe(true);
  const attemptsByBackend = new Map<number | undefined, number>();
  for (const [index, statement] of raced.capture.statements.entries()) {
    if (statement !== 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY') continue;
    const backend = raced.capture.statementBackends![index];
    attemptsByBackend.set(backend, (attemptsByBackend.get(backend) ?? 0) + 1);
  }
  expect([...attemptsByBackend.values()].some((count) => count > 1)).toBe(true);
  expect(await native.rows(f.owner)).toHaveLength(1);
  const other = await native.fixture();
  const separate = await other.store.reserve(other.actor, other.collectionId, [definition()]);
  expect(separate.episodes[0]!.locator.ownerAccountId).not.toBe(f.owner.accountId);
  expect(separate.episodes[0]!.workflowId).not.toBe(raced.value[0].episodes[0]!.workflowId);
  const id = raced.value[0].episodes[0]!.workflowId;
  expect(
    (await native.db.admin.query('SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid=$1', [id]))
      .rowCount,
  ).toBe(1);
  expect(
    (await native.db.admin.query('SELECT workflow_uuid FROM dbos.workflow_input WHERE workflow_uuid=$1', [id]))
      .rowCount,
  ).toBe(1);
});

test('foreign and anonymous private-Collection reservation deny with native not_found before writes', async () => {
  const f = await native.fixture();
  for (const persona of [native.personas.bob, null]) {
    const denied = await capture(native.db, async () => {
      await expect(f.store.reserve(await native.actor(persona), f.collectionId, [definition()])).rejects.toMatchObject(
        new ProblemError('not_found'),
      );
    });
    expect(denied.capture.statements.some((sql) => /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/i.test(sql))).toBe(false);
  }
});

test('native insufficient scope and pre-suspension bearer retain existing HTTP denial shapes before preparation writes', async () => {
  const f = await native.fixture(native.personas.alice);
  const unscoped = await native.withoutScope(f.owner, 'collection:read');
  const denied = await capture(native.db, async () => {
    const scoped = await native.actor(unscoped);
    await expect(f.store.reserve(scoped, f.collectionId, [definition()])).rejects.toMatchObject(
      new ProblemError('not_found'),
    );
    const suspended = await native.send(native.personas.suspended, 'GET', `/v1/collections/${f.collectionId}/members`);
    expect(suspended.status).toBe(401);
    expect(await suspended.json()).toMatchObject({ code: 'invalid_credentials', status: 401 });
    expect(suspended.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
  });
  expect(denied.capture.statements.some((sql) => /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/i.test(sql))).toBe(false);
});

for (const boundary of ['body', 'enqueue'] as const) {
  test(`actual PostgreSQL ${boundary} failure rolls back header and both DBOS rows; retry creates one episode`, async () => {
    const f = await native.fixture();
    // First reach the product method after valid native setup; no absent-table setup failure masks this RED.
    await f.store.reserve(f.actor, f.collectionId, [definition()]);
    const before = await native.rows(f.owner);
    const workflows = (
      await native.db.admin.query('SELECT workflow_uuid FROM dbos.workflow_status ORDER BY workflow_uuid')
    ).rows;
    const inputs = (
      await native.db.admin.query('SELECT workflow_uuid,inputs FROM dbos.workflow_input ORDER BY workflow_uuid')
    ).rows;
    const relation = boundary === 'body' ? 'library.members_preparation' : 'dbos.workflow_input';
    await native.db.admin.query(
      `CREATE FUNCTION public.members_preparation_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'native preparation ${boundary} failure'; END $$`,
    );
    await native.db.admin.query(
      `CREATE TRIGGER members_preparation_fail BEFORE INSERT ON ${relation} FOR EACH ROW EXECUTE FUNCTION public.members_preparation_fail()`,
    );
    try {
      await expect(f.store.reserve(f.actor, f.collectionId, [definition(1)])).rejects.toMatchObject({
        message: `native preparation ${boundary} failure`,
      });
      expect(await native.rows(f.owner)).toEqual(before);
      expect(
        (await native.db.admin.query('SELECT workflow_uuid,inputs FROM dbos.workflow_input ORDER BY workflow_uuid'))
          .rows,
      ).toEqual(inputs);
      expect(
        (await native.db.admin.query('SELECT workflow_uuid FROM dbos.workflow_status ORDER BY workflow_uuid')).rows,
      ).toEqual(workflows);
    } finally {
      await native.db.admin.query(`DROP TRIGGER members_preparation_fail ON ${relation}`);
      await native.db.admin.query('DROP FUNCTION public.members_preparation_fail()');
    }
    const retry = await f.store.reserve(f.actor, f.collectionId, [definition(1)]);
    expect(retry.intent).not.toBeNull();
    expect(await native.rows(f.owner)).toHaveLength(before.length + 1);
    expect((await native.workflow(retry.episodes[0]!.workflowId)).status?.status).toBe('ENQUEUED');
  });
}

test('quota boundary serializes concurrent 33rd and 34th definitions, preserves recent reads and retires only deterministic LRU headers', async () => {
  const f = await native.fixture();
  const episodes: PreparingEpisode[] = [];
  for (let ordinal = 0; ordinal < 32; ordinal++)
    episodes.push(
      (await f.store.reserve(await native.actor(f.owner), f.collectionId, [definition(ordinal)])).episodes[0]!,
    );
  native.advance(1);
  expect(await f.store.touch(await native.actor(f.owner), episodes[0]!.locator)).toBe(true);
  const initial = await native.rows(f.owner);
  const oldest = initial
    .filter((row) => row.episode_id !== episodes[0]!.locator.episodeId)
    .sort((a, b) => String(a.episode_id).localeCompare(String(b.episode_id)))
    .slice(0, 2);
  const second = native.db.openPool({ max: 1 });
  const firstActor = await native.actor(f.owner);
  const secondActor = await native.actor(f.owner, second);
  const result = await capture(native.db, () =>
    Promise.all([
      f.store.reserve(firstActor, f.collectionId, [definition(32)]),
      native.store(second).reserve(secondActor, f.collectionId, [definition(33)]),
    ]),
  );
  const rows = await native.rows(f.owner);
  expect(rows.filter((row) => row.state === 'live')).toHaveLength(32);
  expect(
    rows
      .filter((row) => row.state === 'retired')
      .map((row) => row.episode_id)
      .sort(),
  ).toEqual(oldest.map((row) => row.episode_id).sort());
  expect(rows.find((row) => row.episode_id === episodes[0]!.locator.episodeId)?.state).toBe('live');
  expect(result.value.flatMap((value) => value.intent!.input.cleanup)).toHaveLength(2);
  expect(result.capture.statements.some((sql) => /DELETE FROM library\.|CASCADE/i.test(sql))).toBe(false);
  const duplicateActor = await native.actor(f.owner);
  const duplicate = await capture(native.db, () => f.store.reserve(duplicateActor, f.collectionId, [definition(33)]));
  expect(duplicate.value.intent).toBeNull();
  expect(duplicate.capture.statements.filter((sql) => /FROM library.members_preparation\b/i.test(sql))).toHaveLength(1);
  expect(await native.rows(f.owner)).toEqual(rows);
  expect(duplicate.capture.statements.some((sql) => /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/i.test(sql))).toBe(false);
});

test('one composed two-read admission has one batch intent, including quota retirement cleanup, without a second enqueue', async () => {
  const f = await native.fixture();
  for (let ordinal = 0; ordinal < 32; ordinal++)
    await f.store.reserve(await native.actor(f.owner), f.collectionId, [definition(ordinal)]);
  const actor = await native.actor(f.owner);
  const result = await capture(native.db, () =>
    f.store.reserve(actor, f.collectionId, [definition(32), definition(33), definition(32)]),
  );
  expect(result.value.episodes).toHaveLength(2);
  expect(result.value.intent!.input.episodes).toHaveLength(2);
  expect(result.value.intent!.input.cleanup).toHaveLength(2);
  expect(new Set(result.value.episodes.map((episode) => episode.workflowId)).size).toBe(1);
  expect(result.capture.statements.filter((sql) => /INSERT INTO ["\w.]*workflow_status/i.test(sql))).toHaveLength(1);
  expect(result.capture.statements.filter((sql) => /INSERT INTO ["\w.]*workflow_input/i.test(sql))).toHaveLength(1);
  expect((await native.workflow(result.value.intent!.workflowId)).input).toEqual(result.value.intent!.input);
});

test('trusted idle expiry creates a distinct native episode and workflow; old completed input is never reused', async () => {
  const f = await native.fixture();
  const old = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  // Native terminal scheduling only, never a fabricated ready result or worker success claim.
  await native.db.admin.query(
    "UPDATE dbos.workflow_status SET status='SUCCESS', completed_at=1 WHERE workflow_uuid=$1",
    [old.workflowId],
  );
  const oldInput = (await native.workflow(old.workflowId)).input;
  native.advance(24 * 60 * 60 * 1000);
  const successor = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  expect(successor.locator.episodeId).not.toBe(old.locator.episodeId);
  expect(successor.workflowId).not.toBe(old.workflowId);
  expect((await native.workflow(old.workflowId)).input).toEqual(oldInput);
  expect((await native.workflow(successor.workflowId)).status?.status).toBe('ENQUEUED');
  const before = await native.rows(f.owner);
  expect(await native.step(old.locator)).toBe(false);
  expect(await native.rows(f.owner)).toEqual(before);
  expect(await f.store.touch(f.actor, old.locator)).toBe(false);
});

test('a native work-step admission boundary refuses an absent episode without creating it', async () => {
  const f = await native.fixture();
  const locator = native.locator(f.owner, f.collectionId);
  const observed = await capture(native.db, () => native.step(locator));
  expect(observed.value).toBe(false);
  expect(observed.capture.statements.some((sql) => /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/i.test(sql))).toBe(false);
});

test('a digest hit with unequal retained canonical bytes fails closed instead of sharing a different definition', async () => {
  const f = await native.fixture();
  const episode = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  await native.db.admin.query(
    'UPDATE library.members_preparation SET canonical_basis=$4 WHERE route=$1 AND owner_account_id=$2 AND episode_id=$3',
    [
      episode.locator.route,
      f.owner.accountId,
      episode.locator.episodeId,
      canonicalize([1, f.owner.accountId, f.collectionId, definition(1).filter, 'id', definition(1).release.digest]),
    ],
  );
  await expect(f.store.reserve(f.actor, f.collectionId, [definition()])).rejects.toMatchObject(
    new ProblemError('unsupported_query'),
  );
});

test('touch refuses an absent locator rather than recreating it or charging owner quota', async () => {
  const f = await native.fixture();
  expect(await f.store.touch(f.actor, native.locator(f.owner, f.collectionId))).toBe(false);
});

test('late work refuses retired and physically removed episodes and cannot mutate a successor', async () => {
  const f = await native.fixture();
  const old = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  await native.db.admin.query(
    `WITH retired AS (UPDATE library.members_preparation SET state='retired'
      WHERE route=$1 AND owner_account_id=$2 AND episode_id=$3 AND state='live' RETURNING 1)
      UPDATE library.members_preparation_owner SET live_count=live_count-(SELECT count(*) FROM retired)
      WHERE route=$1 AND owner_account_id=$2`,
    [old.locator.route, f.owner.accountId, old.locator.episodeId],
  );
  const successor = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  const before = await native.rows(f.owner);
  expect(await native.step(old.locator)).toBe(false);
  expect(await native.rows(f.owner)).toEqual(before);
  await native.db.admin.query(
    'DELETE FROM library.members_preparation WHERE route=$1 AND owner_account_id=$2 AND episode_id=$3',
    [old.locator.route, f.owner.accountId, old.locator.episodeId],
  );
  expect(await native.step(old.locator)).toBe(false);
  expect((await native.rows(f.owner)).map((row) => row.episode_id)).toEqual([successor.locator.episodeId]);
});

test('fresh Auth deletePersona commits T between intent and step; late work and T-first admission cannot recreate metadata', async () => {
  const f = await native.fixture();
  const episode = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  await native.deletePersona(f.owner);
  expect(
    (
      await native.db.admin.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [
        episode.locator.route,
        f.owner.accountId,
      ])
    ).rows,
  ).toEqual([{ state: 'deleted' }]);
  const before = await native.rows(f.owner);
  const workflows = (
    await native.db.admin.query('SELECT workflow_uuid,inputs FROM dbos.workflow_input ORDER BY workflow_uuid')
  ).rows;
  await expect(native.step(episode.locator)).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(f.store.reserve(f.actor, f.collectionId, [definition(1)])).rejects.toMatchObject(
    new ProblemError('not_found'),
  );
  expect(await native.rows(f.owner)).toEqual(before);
  expect((await native.workflow(episode.workflowId)).input.accounts).toEqual([f.owner.accountId]);
  expect(
    (await native.db.admin.query('SELECT workflow_uuid,inputs FROM dbos.workflow_input ORDER BY workflow_uuid')).rows,
  ).toEqual(workflows);
});

test('preT native operational account share completes before T and Auth deletion waits on its actual row lock', async () => {
  const f = await native.fixture();
  const episode = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
  const pool = native.db.openPool({ max: 1 });
  const held = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const locator = episode.locator;
  const applying = runOperationalTransaction(
    pool,
    {
      mode: 'work-step',
      partition: partitionOf(locator.route),
      kind: 'library.membersPreparation.step',
      accounts: [f.owner.accountId],
      workClient: native.workClient,
    },
    async (tx) => {
      const pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      held.resolve(pid);
      await release.promise;
      return native.store(pool).admitStep(tx, locator);
    },
  );
  const pid = await held.promise;
  const deleting = native.deletePersona(f.owner);
  try {
    let blocked = false;
    for (let probe = 0; probe < 1000 && !blocked; probe++) {
      blocked = (
        await native.db.admin.query<{ blocked: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%access.account%') AS blocked`,
          [pid],
        )
      ).rows[0]!.blocked;
      if (!blocked) await Bun.sleep(1);
    }
    expect(blocked).toBe(true);
  } finally {
    release.resolve();
  }
  const results = await Promise.allSettled([applying, deleting]);
  expect(results[0]).toEqual({ status: 'fulfilled', value: true });
  expect(results[1]!.status).toBe('fulfilled');
});

// These named series stay RED at reserve today. The producer must run actual checkGrowth, never infer cost from compile.
for (const operation of ['first202', 'duplicate', 'quota-full retirement', 'forced-one-contention-retry'] as const) {
  for (const axis of ['retired owner results', 'unrelated workflow history'] as const) {
    test(`native preparation growth: ${operation} versus ${axis} at 64/512/4096`, async () => {
      const f = await native.fixture();
      const anchor = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
      if (operation === 'quota-full retirement')
        for (let ordinal = 1; ordinal < 32; ordinal++)
          await f.store.reserve(await native.actor(f.owner), f.collectionId, [definition(ordinal)]);
      let measuredActor = f.actor;
      const second = operation === 'forced-one-contention-retry' ? native.db.openPool({ max: 1 }) : null;
      let competingActor = f.actor;
      const prepare = async () => {
        measuredActor = await native.actor(f.owner);
        if (second) competingActor = await native.actor(f.owner, second);
        if (operation === 'duplicate') return;
        // Test-only negative scheduling, outside captures, preserving the live-count invariant.
        await native.db.admin.query(
          `WITH retired AS (UPDATE library.members_preparation SET state='retired'
              WHERE route=$1 AND owner_account_id=$2 AND canonical_basis=$3 AND state='live' RETURNING 1)
              UPDATE library.members_preparation_owner SET live_count=live_count-(SELECT count(*) FROM retired)
              WHERE route=$1 AND owner_account_id=$2`,
          [
            anchor.locator.route,
            f.owner.accountId,
            canonicalize([
              1,
              f.owner.accountId,
              f.collectionId,
              definition(40).filter,
              'id',
              definition(40).release.digest,
            ]),
          ],
        );
        if (operation === 'quota-full retirement')
          for (let ordinal = 0; ordinal < 32; ordinal++)
            await f.store.reserve(await native.actor(f.owner), f.collectionId, [definition(ordinal)]);
      };
      const report = await checkGrowth(native.db, {
        name: `Library reservation ${operation} / ${axis}`,
        scales: [64, 512, 4096],
        includeBackends: true,
        bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
        async grow(db, scale, previous) {
          await retainEpisodes(db, anchor.locator, scale - previous, {
            headers: axis === 'retired owner results',
            queued: false,
          });
        },
        prepare,
        async warmup(db, scale, repetition) {
          await prepare();
          await this.operation(db, scale, repetition);
        },
        async operation() {
          if (operation === 'duplicate') {
            await f.store.reserve(measuredActor, f.collectionId, [definition()]);
            return;
          }
          if (operation === 'forced-one-contention-retry') {
            const barrier = uniquenessRace([native.db.pool, second!]);
            await barrier.arm();
            await Promise.all([
              f.store.reserve(measuredActor, f.collectionId, [definition(40)]),
              native.store(second!).reserve(competingActor, f.collectionId, [definition(40)]),
            ]).finally(() => barrier.restore());
            expect(barrier.arrivals()).toBe(2);
          } else await f.store.reserve(measuredActor, f.collectionId, [definition(40)]);
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
      console.log(JSON.stringify(report));
    });
  }
}

for (const axis of [
  'expired/retired episodes',
  'successor generations',
  'queued stale intents',
  'unrelated histories',
] as const) {
  test(`native retired-header growth: exact obsolete step versus ${axis} at 64/512/4096`, async () => {
    const f = await native.fixture();
    const episode = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
    native.advance(24 * 60 * 60 * 1000);
    const successor = (await f.store.reserve(f.actor, f.collectionId, [definition()])).episodes[0]!;
    expect(successor.locator.episodeId).not.toBe(episode.locator.episodeId);
    const report = await checkGrowth(native.db, {
      name: `obsolete exact episode / ${axis}`,
      scales: [64, 512, 4096],
      includeBackends: true,
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      async grow(db, scale, previous) {
        await retainEpisodes(db, episode.locator, scale - previous, {
          headers: axis !== 'unrelated histories',
          queued: axis === 'queued stale intents',
        });
      },
      async operation() {
        expect(await native.step(episode.locator)).toBe(false);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    console.log(JSON.stringify(report));
  });
}
