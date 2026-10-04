import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';
import {
  engageAccessRecoveryFence,
  releaseAccessRecoveryFence,
  type GraphTerminalProof,
} from '../../../services/main/src/modules/access/admission.ts';
import { reconstructLegacyTargetRatings } from '../../../services/main/src/modules/rating/legacy-reconstruction.ts';
import { scopedJudgmentsFixture } from './scoped-judgments-support.ts';
import { startRatingStack } from './rating-components-support.ts';

/** Pause after a real SQL lock is acquired, while retaining the transaction. */
function pauseQuery(pool: Pool, matches: (sql: string, params: readonly unknown[]) => boolean) {
  let reached!: () => void, resume!: () => void;
  const locked = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const connect = pool.connect.bind(pool),
    originals = new Map<PoolClient, PoolClient['query']>();
  let used = false;
  const instrument = (client: PoolClient) => {
    if (!originals.has(client)) {
      const query = client.query;
      originals.set(client, query);
      const run = query.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((...args: unknown[]) => {
        // pg's pool.query uses the callback overload on checked-out clients.
        if (typeof args.at(-1) === 'function') return run(...args);
        return (async () => {
          const [sql, params = []] = args as [string, unknown[]?];
          const result = await run(sql, params);
          if (!used && matches(sql, params)) {
            used = true;
            reached();
            await released;
          }
          return result;
        })();
      }) as typeof client.query;
    }
    return client;
  };
  pool.connect = ((...args: unknown[]) => {
    if (typeof args[0] === 'function') return (connect as (...args: unknown[]) => unknown)(...args);
    return connect().then(instrument);
  }) as typeof pool.connect;
  return {
    locked,
    resume,
    restore: () => {
      resume();
      pool.connect = connect;
      for (const [client, query] of originals) client.query = query;
    },
  };
}

/** Database blocking evidence, rather than elapsed time, proves serialization. */
async function blockedQuery(pool: Pool, pattern: string) {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline) {
    const result = await pool.query(
      `SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND query LIKE $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
      [pattern],
    );
    if (result.rowCount) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('two raters on different targets of one Global Context seal concurrently, while one target stays serialized', async () => {
  const h = await scopedJudgmentsFixture();
  const seal = h.stack.access.recordGraphOutcome.bind(h.stack.access);
  const pending: { id: string; proof: GraphTerminalProof }[] = [];
  let pause: ReturnType<typeof pauseQuery> | undefined;
  const operations: Promise<void>[] = [];
  try {
    const [a, b] = [await h.semantic('gate-a'), await h.semantic('gate-b')];
    const q = await h.question({ realm: GLOBAL_RATING_POPULATION_OWNER, targetGrain: 'resource' });
    const third = await h.person('third-global-rater');
    // Delay only Access sealing: every proof was produced by the real admitted API.
    h.stack.access.recordGraphOutcome = async (id, proof) => {
      pending.push({ id, proof });
    };
    for (const [person, target] of [
      [h.owner, a],
      [h.outsider, a],
      [third, b],
    ] as const) {
      expect(
        (
          await h.call(
            person,
            'POST',
            '/v1/rating-observations',
            h.ratingBody(person, q.context, target),
          )
        ).status,
      ).toBe(201);
    }
    h.stack.access.recordGraphOutcome = seal;
    pause = pauseQuery(
      h.stack.accessPool,
      (sql, params) =>
        sql.includes('rating_observation_gate') && sql.includes('FOR UPDATE') && params[1] === a,
    );
    const first = seal(pending[0]!.id, pending[0]!.proof);
    operations.push(first);
    await Promise.race([pause.locked, first.then(() => { throw new Error('Seal did not acquire its target gate'); })]);
    const same = seal(pending[1]!.id, pending[1]!.proof);
    operations.push(same);
    const other = seal(pending[2]!.id, pending[2]!.proof);
    operations.push(other);
    await other;
    expect(await blockedQuery(h.stack.accessPool, '%rating_observation_gate%')).toBe(true);
    // The independent seal committed while the first transaction still holds its target gate.
    expect(
      (
        await h.stack.accessPool.query('SELECT state, scope_id FROM access.admission WHERE id=$1', [
          pending[2]!.id,
        ])
      ).rows[0],
    ).toEqual({ state: 'sealed', scope_id: `rating:observe:${q.context}` });
    pause.resume();
    await Promise.all([first, same]);
    const rows = (
      await h.stack.accessPool.query(
        'SELECT target, slots, rating_count FROM access.target_rating_component WHERE context=$1 ORDER BY target',
        [q.context],
      )
    ).rows;
    expect(rows).toEqual(
      [
        { target: a, slots: 2, rating_count: 2 },
        { target: b, slots: 1, rating_count: 1 },
      ].sort((x, y) => x.target.localeCompare(y.target)),
    );
  } finally {
    h.stack.access.recordGraphOutcome = seal;
    pause?.restore();
    await Promise.allSettled(operations);
    await h.stop();
  }
}, 300_000);

test('reconstruction holds the recovery fence FOR SHARE until its values commit, and reads never take the Context write gate', async () => {
  const r = await startRatingStack('rating-reconstruction-fence');
  let pause: ReturnType<typeof pauseQuery> | undefined;
  let reconstruction: Promise<unknown> | undefined, closing: Promise<string> | undefined;
  const authority = await r.stack.accessPool.connect();
  try {
    const { context } = await r.context({ displayThreshold: 1 });
    const target = await r.resource('legacy-fence'),
      rater = await r.person('legacy-fence-rater');
    await r.rate(rater, context, target, 8);
    const before = await r.aggregate(context, target);
    await authority.query('BEGIN');
    await authority.query('SELECT 1 FROM access.scope_gate WHERE id=$1 FOR UPDATE', [
      `rating:observe:${context}`,
    ]);
    expect(await r.aggregate(context, target)).toEqual(before);
    await r.stack.accessPool.query(
      'UPDATE access.target_rating_head SET value=NULL,value_known=false WHERE context=$1',
      [context],
    );
    await r.stack.accessPool.query(
      'UPDATE access.target_rating_component SET unvalued=1,rating_count=0,rating_sum=0,histogram=$2 WHERE context=$1',
      [context, Array(10).fill(0)],
    );
    expect(
      (
        await r.call(r.owner, 'POST', '/v1/rating-aggregates', {
          profile: 'realm-target-latest-mean-v1',
          context,
          target,
          actingSubject: r.owner.actor,
        })
      ).status,
    ).toBe(503);
    expect((await r.components(context, target)).row.unvalued).toBe(1);
    await authority.query('COMMIT');
    pause = pauseQuery(r.stack.accessPool, (sql) =>
      sql.includes('SELECT open, generation FROM access.recovery_fence'),
    );
    reconstruction = reconstructLegacyTargetRatings(r.stack.env, r.stack.accessPool, {
      context,
      target,
    });
    await Promise.race([pause.locked, reconstruction.then(() => { throw new Error('Reconstruction did not read its fence'); })]);
    closing = engageAccessRecoveryFence(r.stack.accessPool);
    expect(await blockedQuery(r.stack.accessPool, '%UPDATE access.recovery_fence%')).toBe(true);
    pause.resume();
    expect(await reconstruction).toMatchObject({ complete: true, recorded: 1 });
    const generation = await closing;
    expect((await r.components(context, target)).row).toMatchObject({
      unvalued: 0,
      count: 1,
      sum: 8,
    });
    await releaseAccessRecoveryFence(r.stack.accessPool, generation);
    expect(await r.aggregate(context, target)).toEqual(before);
  } finally {
    pause?.restore();
    await Promise.allSettled([reconstruction, closing]);
    await authority.query('ROLLBACK');
    authority.release();
    await r.stop();
  }
}, 300_000);
