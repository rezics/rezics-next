import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { runCommand } from '../../src/command/command.ts';
import { withQueryAccounting } from '../../src/database/pool.ts';
import type { Effect, NativeEffect } from '../../src/events/effects.ts';
import { projectBatch, type CloudEvent } from '../../src/events/log.ts';
import { rebuildRealmRankCanonicalOrder } from '../../src/rating/realm-rank-convergence.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  CANONICAL_GENERATION_PAGE_SIZE,
  createCanonicalGenerationWakeEffect,
  deliverCanonicalGenerationEvent,
  readCanonicalGenerationDeliveryPage,
  resumeCanonicalGenerationDelivery,
} from '../../src/semantic/canonical-generation-delivery.ts';
import {
  CANONICAL_GENERATION_COMMITTED,
  CANONICAL_GENERATION_CONTINUATION,
  CANONICAL_GENERATION_DELIVERED,
  CANONICAL_GENERATION_REBUILD_CONTINUED,
} from '../../src/semantic/events.ts';
import { subjectTarget } from '../../src/semantic/subject.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import { fixture, readContext } from './support/public-filter-source.ts';

async function insertSubjects(pool: Pool, partitions: number[]) {
  const routes = partitions.map((partition) => partition * 16);
  const subjects = routes.map((route) => newId(route));
  await pool.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id)
     SELECT route,id,'schema:Person',gen_random_uuid() FROM unnest($1::int[],$2::uuid[]) AS input(route,id)`,
    [routes, subjects],
  );
  return subjects;
}

test('canonical delivery recovery yields after 32 native homes even with a retained wide request', async () => {
  const f = await fixture();
  try {
    const pool = f.db.openPool({ max: 5 });
    const blank = { after: null, limit: CANONICAL_GENERATION_PAGE_SIZE };
    expect((await readCanonicalGenerationDeliveryPage(pool, blank, readContext())).homes).toEqual([]);
    await resumeCanonicalGenerationDelivery(pool, blank);
    const blankState = await pool.query(
      `SELECT count(*)::int AS untouched,
              (SELECT count(*)::int FROM rating.realm_rank_canonical_state) AS coverage,
              (SELECT count(*)::int FROM core.outbox WHERE type IN ($1,$2)) AS notices
       FROM semantic.partition_subjects WHERE canonical_generation=1
         AND canonical_announced_generation=0 AND canonical_delivered_generation=0`,
      [CANONICAL_GENERATION_COMMITTED, CANONICAL_GENERATION_CONTINUATION],
    );
    expect(blankState.rows).toEqual([{ untouched: 4096, coverage: 0, notices: 0 }]);
    await insertSubjects(
      f.db.admin,
      Array.from({ length: 33 }, (_, i) => i + 1),
    );
    const request = { after: 0, limit: CANONICAL_GENERATION_PAGE_SIZE };
    const { homes } = await readCanonicalGenerationDeliveryPage(
      pool,
      { ...request, limit: 33 },
      { deadline: Date.now() + 2_000 },
    );
    expect(homes).toHaveLength(33);

    await resumeCanonicalGenerationDelivery(pool, request);
    const { rows } = await f.db.admin.query(
      'SELECT type,data FROM core.outbox WHERE type IN ($1,$2) ORDER BY partition_no,position,event_seq',
      [CANONICAL_GENERATION_COMMITTED, CANONICAL_GENERATION_CONTINUATION],
    );
    expect(rows).toEqual([
      ...homes.slice(0, 32).map((data) => ({ type: CANONICAL_GENERATION_COMMITTED, data })),
      { type: CANONICAL_GENERATION_CONTINUATION, data: { after: homes[31]!.partition, limit: request.limit } },
    ]);
  } finally {
    await f.close();
  }
});

test('overlapping canonical wakes announce a home once and startup can recover an undelivered generation', async () => {
  const f = await fixture();
  try {
    const home = 4095;
    await insertSubjects(f.db.admin, [home]);
    const request = { after: home - 1, limit: 1 };
    const pool = f.db.openPool({ max: 2 });
    const wake = () => resumeCanonicalGenerationDelivery(pool, { ...request, unannouncedOnly: true });
    const notices = async () =>
      (
        await f.db.admin.query(
          'SELECT data FROM core.outbox WHERE partition_no=$1 AND type=$2 ORDER BY position,event_seq',
          [home, CANONICAL_GENERATION_COMMITTED],
        )
      ).rows.map(({ data }) => data);
    const pending = await readCanonicalGenerationDeliveryPage(pool, request, readContext());
    expect(pending.homes).toHaveLength(1);
    await Promise.all([wake(), wake()]);
    await wake();
    expect(await notices()).toEqual([...pending.homes]);
    expect((await readCanonicalGenerationDeliveryPage(pool, request, readContext())).homes).toEqual(pending.homes);
    await resumeCanonicalGenerationDelivery(pool, request);
    expect(await notices()).toEqual([...pending.homes, ...pending.homes]);
  } finally {
    await f.close();
  }
});

test('a Book wake arriving after an inventory snapshot gets a new scan and can retry a failed scan', async () => {
  const f = await fixture({ isolated: true });
  const firstRead = Promise.withResolvers<void>();
  const releaseRead = Promise.withResolvers<void>();
  try {
    const pool = f.db.openPool({ max: 6 });
    const effect = createCanonicalGenerationWakeEffect(pool);
    const bookKey = (partition: number) => {
      let key = randomUUID();
      while (partitionOf(subjectTarget(f.config.routeKey, f.accounts.editor, key).route) !== partition)
        key = randomUUID();
      return key;
    };
    const createWake = async (partition: number, key: string) => {
      const subject = await f.create('schema:Book', {}, key);
      const events: CloudEvent[] = [];
      const result = await projectBatch(pool, {
        consumer: 'canonical_book_wake_test',
        partition,
        apply: async (envelopes) => {
          events.push(...envelopes.flatMap((envelope) => envelope.events));
        },
      });
      expect(result.status).toBe('read');
      const event = events.find((entry) => entry.subject === subject && entry.type === 'com.rezics.subject.created.v1');
      if (!event) throw new Error('Missing native Book creation event');
      return event;
    };
    // Announce both initial homes. Only a new Book can return either one to the inventory.
    await resumeCanonicalGenerationDelivery(pool, { after: null, limit: 2, unannouncedOnly: true });
    const first = await createWake(0, bookKey(0));
    const laterKey = bookKey(1);
    let scans = 0;
    const watch = (run: () => Promise<void>) =>
      withQueryAccounting(
        {
          connection: (dispatch) => dispatch(),
          async query(sql, _operands, dispatch) {
            const rows = await dispatch();
            if (sql.includes('AND canonical_announcement_pending')) {
              if (++scans === 1) {
                firstRead.resolve();
                await releaseRead.promise;
              } else if (scans === 2) {
                throw new Error('Inventory result unavailable');
              }
            }
            return rows;
          },
        },
        run,
      );
    const original = watch(() => effect.run(first));
    await Promise.race([
      firstRead.promise,
      original.then(() => {
        throw new Error('Inventory was not observed');
      }),
    ]);
    const later = await createWake(1, laterKey);
    const queued = watch(() => effect.run(later));
    const replay = watch(() => effect.run(later));
    const results = Promise.allSettled([original, queued, replay]);
    releaseRead.resolve();
    expect(await results).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: new Error('Inventory result unavailable') },
      { status: 'rejected', reason: new Error('Inventory result unavailable') },
    ]);
    expect(scans).toBe(2);
    const home = () =>
      readCanonicalGenerationDeliveryPage(pool, { after: 0, limit: 1, unannouncedOnly: true }, readContext());
    expect((await home()).homes[0]?.partition).toBe(1);
    await watch(() => effect.run(later));
    expect(scans).toBe(3);
    expect((await home()).homes[0]?.partition).not.toBe(1);
    const announced = await f.db.admin.query(
      `SELECT count(*)::int AS n FROM core.outbox o JOIN semantic.partition_subjects s USING(partition_no)
       WHERE o.partition_no=1 AND o.type=$1 AND o.data->>'generation'=s.canonical_generation::text`,
      [CANONICAL_GENERATION_COMMITTED],
    );
    expect(announced.rows[0]?.n).toBe(1);
  } finally {
    releaseRead.resolve();
    await f.close();
  }
});

test('default Content dispatch requires a complete native rebuild before acknowledging a canonical generation', async () => {
  const f = await fixture();
  try {
    const subject = await f.create();
    const route = routeOf(subject)!;
    const partition = partitionOf(route);
    const pool = f.db.openPool({ max: 1 });
    const effects: (Effect | NativeEffect)[] = [];
    const client = await createWorkClient(f.db.url, pool);
    try {
      await KERNEL_WORK_MODULES.find(({ name }) => name === 'content')!.register({
        pool,
        client,
        queues: WORK_QUEUES,
        clock: f.config.clock,
        env: workerTestEnv(),
        getAuthorization: () => ({ access: f.config.access, readConsent: async () => null }),
        addEffects: (registered) => effects.push(...registered),
        addNativeEffects: (registered) => effects.push(...registered),
        addService: () => {},
      });
    } finally {
      await client.close();
    }
    const consumers = effects.filter(({ types }) => types.includes(CANONICAL_GENERATION_COMMITTED));
    expect(consumers.map(({ name }) => name)).toEqual(['content_canonical_work']);
    const [receiver] = consumers;
    if (!receiver || receiver.delivery === 'native') throw new Error('Expected the canonical generation workflow');
    expect(receiver.types).toContain(CANONICAL_GENERATION_REBUILD_CONTINUED);

    const request = (home: number) => ({ after: home === 0 ? null : home - 1, limit: 1 });
    const counter = async (home: number) =>
      (
        await f.db.admin.query<{
          generation: string;
          delivered: string;
          count: string;
        }>(
          `SELECT canonical_generation::text AS generation,canonical_delivered_generation::text AS delivered,
              canonical_count::text AS count FROM semantic.partition_subjects WHERE partition_no=$1`,
          [home],
        )
      ).rows[0]!;
    const pending = (home: number) => readCanonicalGenerationDeliveryPage(pool, request(home), readContext());
    const coverage = async (home: number) =>
      (
        await f.db.admin.query<{ complete: string | null }>(
          'SELECT canonical_generation::text AS complete FROM rating.realm_rank_canonical_state WHERE partition_no=$1',
          [home],
        )
      ).rows[0];
    const notifications = async (home: number) => {
      const events: CloudEvent[] = [];
      // Read the actual kernel envelope; never construct a source identity from an affected ID.
      for (let page = 0; page < 10; page++) {
        const result = await projectBatch(pool, {
          partition: home,
          consumer: 'canonical_generation_delivery_test',
          apply: async (envelopes) => {
            events.push(...envelopes.flatMap((envelope) => envelope.events));
          },
        });
        expect(result.status).toBe('read');
        if (result.status !== 'read') throw new Error('Native canonical test log stopped');
        if (result.envelopes === 0) return events;
      }
      throw new Error('Canonical fixture exceeded its native event bound');
    };
    const committed = (events: CloudEvent[]) => {
      const event = events.findLast((entry) => entry.type === CANONICAL_GENERATION_COMMITTED);
      expect(event).toBeDefined();
      return event!;
    };

    const initial = await counter(partition);
    await expect(
      runCommand(pool, { partition }, async (tx) => {
        await tx.query(
          `UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1
           WHERE route=$1 AND subject_id=$2`,
          [route, subject],
        );
        const home = await tx.query(
          `SELECT canonical_count::text AS count, canonical_generation::text AS generation,
              (SELECT n_tup_upd::int FROM pg_stat_xact_user_tables
               WHERE relid='semantic.partition_subjects'::regclass) AS writes
           FROM semantic.partition_subjects WHERE partition_no=$1`,
          [partition],
        );
        expect(home.rows[0]).toEqual({
          count: initial.count,
          generation: String(BigInt(initial.generation) + 2n),
          writes: 1,
        });
        throw new Error('abort canonical change');
      }),
    ).rejects.toThrow('abort canonical change');
    expect(await counter(partition)).toEqual(initial);
    expect((await pending(partition)).homes[0]).toEqual({ partition, generation: initial.generation });

    await resumeCanonicalGenerationDelivery(pool, request(partition));
    const firstEvents = await notifications(partition);
    const first = committed(firstEvents);
    expect(first.data).toEqual({ partition, generation: initial.generation });
    expect(first.source).toMatch(new RegExp(`^urn:rezics:log:${partition}\\.[1-9][0-9]*$`));
    if (partition < 4095) {
      expect(firstEvents.findLast((event) => event.type === CANONICAL_GENERATION_CONTINUATION)?.data).toEqual({
        after: partition,
        limit: 1,
      });
    }
    await expect(
      deliverCanonicalGenerationEvent(pool, first, async (tx, generation, envelope) => {
        expect<unknown>(generation).toEqual(first.data);
        expect(envelope).toBe(first);
        const page = await rebuildRealmRankCanonicalOrder(tx, { partition, limit: 200 });
        return { ...page, canonicalGeneration: '0' };
      }),
    ).rejects.toThrow('Invalid whole-home canonical generation witness');
    expect(await counter(partition)).toEqual(initial);
    expect(await coverage(partition)).toBeUndefined();

    await f.db.admin.query(
      `INSERT INTO rating.realm_rank
         (partition_no,question_id,population_id,subject_id,count,mean,score,prior_epoch,prior_generation,revision,as_of)
       SELECT $1,gen_random_uuid(),$2,$2,5,1,1,1,1,1,now() FROM generate_series(1,200)`,
      [partition, subject],
    );
    const orphan = newId(route);
    const admin = await f.db.admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query("SET LOCAL session_replication_role='replica'");
      await admin.query(
        `UPDATE rating.realm_rank SET subject_id=$2 WHERE partition_no=$1 AND question_id=(
           SELECT min(question_id::text)::uuid FROM rating.realm_rank WHERE partition_no=$1
         )`,
        [partition, orphan],
      );
      await admin.query('COMMIT');
    } finally {
      admin.release();
    }
    await expect(receiver.run(first)).rejects.toThrow('Realm rank canonical Subject is unavailable');
    expect(await counter(partition)).toEqual(initial);
    expect(await coverage(partition)).toBeUndefined();
    await f.db.admin.query('UPDATE rating.realm_rank SET subject_id=$2 WHERE partition_no=$1 AND subject_id=$3', [
      partition,
      subject,
      orphan,
    ]);

    await receiver.run(first);
    expect(await counter(partition)).toEqual(initial);
    expect(await coverage(partition)).toEqual({ complete: null });
    const continued = (await notifications(partition)).find((e) => e.type === CANONICAL_GENERATION_REBUILD_CONTINUED)!;
    expect(continued.data).toEqual(first);

    await runCommand(pool, { partition }, async (tx) => {
      const row = (
        await tx.query<{ revision: string }>(
          `UPDATE semantic.subject SET visibility='hidden',security_revision=security_revision+1
         WHERE route=$1 AND subject_id=$2 RETURNING security_revision::text AS revision`,
          [route, subject],
        )
      ).rows[0]!;
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.subject.visibility_changed.v1',
            subject,
            data: { id: subject, visibility: 'hidden', security_revision: Number(row.revision) },
          },
        ],
      };
    });
    const later = await counter(partition);
    expect(BigInt(later.generation)).toBeGreaterThan(BigInt(initial.generation));
    await receiver.run(continued);
    expect(await counter(partition)).toEqual(later);
    const resumed = (await notifications(partition)).find((e) => e.type === CANONICAL_GENERATION_REBUILD_CONTINUED)!;
    expect(resumed.data).toEqual(first);
    await receiver.run(resumed);
    expect(await coverage(partition)).toEqual({ complete: later.generation });
    await receiver.run(resumed);
    await receiver.run(first);
    expect((await counter(partition)).delivered).toBe(initial.generation);
    expect((await notifications(partition)).filter((e) => e.type === CANONICAL_GENERATION_DELIVERED)).toHaveLength(1);
    expect((await pending(partition)).homes[0]).toEqual({ partition, generation: later.generation });
    await resumeCanonicalGenerationDelivery(pool, request(partition));
    const newer = committed(await notifications(partition));
    expect(newer.data).toEqual({ partition, generation: later.generation });
    await receiver.run(newer);
    expect((await counter(partition)).delivered).toBe(later.generation);

    // A retained home still owes delivery after its last Subject is deleted.
    const emptyHome = (
      await f.db.admin.query<{ partition: number }>(
        `SELECT partition_no AS partition FROM semantic.partition_subjects
         WHERE canonical_empty_seed AND canonical_generation=1 ORDER BY partition_no LIMIT 1`,
      )
    ).rows[0]!.partition;
    const [removed] = await insertSubjects(f.db.admin, [emptyHome]);
    await runCommand(pool, { partition: emptyHome }, async (tx) => {
      await tx.query("SET LOCAL semantic.erasure_cleanup='on'");
      const key = [emptyHome * 16, removed];
      await tx.query('DELETE FROM semantic.search_selection_state WHERE route=$1 AND subject_id=$2', key);
      await tx.query('DELETE FROM semantic.subject WHERE route=$1 AND subject_id=$2', key);
      return { value: null, events: [{ type: 'com.rezics.test.updated.v1', data: {} }] };
    });
    expect((await counter(emptyHome)).count).toBe('0');
    await resumeCanonicalGenerationDelivery(pool, request(emptyHome));
    const lost = committed(await notifications(emptyHome));
    // Simulate losing the delivery after the source commit. No retained cursor or in-memory
    // notification is needed by startup; the same counter produces a new real native envelope.
    await resumeCanonicalGenerationDelivery(pool, request(emptyHome));
    const recovered = committed(await notifications(emptyHome));
    expect(recovered.id).not.toBe(lost.id);
    expect(recovered.data).toEqual(lost.data);
    await receiver.run(recovered);
    await receiver.run(lost);
    const empty = await counter(emptyHome);
    expect(empty.delivered).toBe(empty.generation);
    expect(await coverage(emptyHome)).toEqual({ complete: empty.generation });
    expect((await notifications(emptyHome)).filter((e) => e.type === CANONICAL_GENERATION_DELIVERED)).toHaveLength(1);
    expect((await pending(emptyHome)).homes.some((home) => home.partition === emptyHome)).toBe(false);
  } finally {
    await f.close();
  }
});
