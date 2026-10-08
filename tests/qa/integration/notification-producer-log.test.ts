import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  engageAccessRecoveryFence,
  releaseAccessRecoveryFence,
} from '../../../services/main/src/modules/access/admission.ts';
import { notificationProducerEventsSql } from '../../../services/main/src/modules/notification-producers/access-log.ts';
import {
  NotificationProducer,
  PRODUCER_COST,
} from '../../../services/main/src/modules/notification-producers/producer.ts';
import type { NotificationEvent } from '../../../services/main/src/modules/notification/store.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let access: Pool;

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
  databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access']);
  access = new Pool({ connectionString: databases.urls.access, max: 8 });
}, 30_000);

beforeEach(async () => {
  await access.query(
    'TRUNCATE access.notification_producer_event, access.notification_producer_cursor',
  );
  await access.query(`INSERT INTO access.notification_producer_cursor (consumer)
    VALUES ('notification-producer-v1'), ('safety-correspondence-v1')`);
});

afterAll(async () => {
  await access?.end();
  await databases?.close();
});

async function append(client: Pool | PoolClient, event = randomUUID()): Promise<string> {
  await client.query("SELECT access.append_notification_producer_event('moderation_outcome', $1)", [
    event,
  ]);
  return event;
}

// Owner facts and intake are adapters here; every append, source read, horizon,
// cursor lock and transaction is the production path on real Access PostgreSQL.
function producer(inbox: (event: NotificationEvent) => Promise<unknown> = async () => []) {
  const recipient = randomUUID();
  const actor = `https://rezics.com/id/${randomUUID()}`;
  // Decision lookup runs on the cursor transaction's client, not the pool.
  const adapt = (query: (sql: string, args: unknown[]) => Promise<unknown>) =>
    async (sql: string, args: unknown[]) => {
      if (sql.includes('FROM access.moderation_decision'))
        return {
          rows: [
            {
              case_id: args[0],
              principal_id: randomUUID(),
              acting_subject: actor,
              context: 'urn:rezics:context:global',
              target_resource: actor,
              statement_of_reasons: {},
            },
          ],
        };
      if (sql.includes('FROM access.governance_report')) return { rows: [] };
      if (sql.includes('FROM access.safety_party_notice')) return { rows: [{ id: recipient }] };
      return query(sql, args);
    };
  const source = {
    connect: async () => {
      const client = await access.connect();
      return new Proxy(client, { get(target, property, receiver) {
        if (property === 'query') return adapt(target.query.bind(target));
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    },
    query: adapt((sql, args) => access.query(sql, args)),
  } as unknown as Pool;
  return new NotificationProducer(
    source,
    null,
    {} as Pool,
    {
      query: async () => {
        throw new Error('Unexpected graph read');
      },
    },
    { enqueue: inbox } as never,
    null,
  );
}

function consumers() {
  const inbox: string[] = [],
    mail: string[] = [];
  const notices = producer(async (event) => {
    inbox.push(event.subject.ref);
    return [];
  });
  const correspondence = producer();
  correspondence.setSafetyCorrespondence({
    enqueueDecision: async (event) => {
      mail.push(event);
    },
  });
  return { inbox, mail, notices, correspondence };
}

test('independent notification appends commit within one second while another writer stays open', async () => {
  const held = await access.connect(),
    other = await access.connect();
  try {
    await held.query('BEGIN');
    const rolledBack = await append(held);
    await other.query('BEGIN');
    await other.query("SET LOCAL lock_timeout = '750ms'");
    await other.query("SET LOCAL statement_timeout = '900ms'");
    const started = performance.now();
    const committed = await append(other);
    await other.query('COMMIT');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(
      (await access.query('SELECT event_id FROM access.notification_producer_event')).rows,
    ).toEqual([{ event_id: committed }]);
    const { notices, correspondence, inbox, mail } = consumers();
    expect(await notices.runAccessOnce()).toBe(0);
    expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(0);
    await held.query('ROLLBACK');
    expect(await notices.runAccessOnce()).toBe(1);
    expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(1);
    expect(inbox).toEqual([committed]);
    expect(mail).toEqual([committed]);
    expect(inbox).not.toContain(rolledBack);
  } finally {
    await held.query('ROLLBACK');
    await other.query('ROLLBACK');
    held.release();
    other.release();
  }
});

test('engaging recovery waits for an appender to commit even without a caller recovery guard', async () => {
  const held = await access.connect(),
    fence = await access.connect();
  let fencing: Promise<{ generation: string } | { error: unknown }> | undefined;
  try {
    await held.query('BEGIN');
    await append(held);
    const holderPid = (await held.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    const fencePid = (await fence.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    const before = (
      await access.query<{ generation: string }>(
        'SELECT generation::text FROM access.recovery_fence WHERE id',
      )
    ).rows[0]!.generation;
    await fence.query('BEGIN');
    await fence.query("SET LOCAL lock_timeout = '2s'");
    await fence.query("SET LOCAL statement_timeout = '3s'");
    fencing = engageAccessRecoveryFence({ query: fence.query.bind(fence) } as unknown as Pool).then(
      (generation) => ({ generation }),
      (error: unknown) => ({ error }),
    );
    const deadline = performance.now() + 1_000;
    let blockers: number[] = [];
    do {
      blockers = (
        await access.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [
          fencePid,
        ])
      ).rows[0]!.blockers;
      if (blockers.includes(holderPid)) break;
      await Bun.sleep(10);
    } while (performance.now() < deadline);
    expect(blockers).toContain(holderPid);
    await held.query('COMMIT');
    const generation = String(BigInt(before) + 1n);
    expect(await fencing).toEqual({ generation });
    await fence.query('COMMIT');
    await releaseAccessRecoveryFence(access, generation);
  } finally {
    await held.query('ROLLBACK');
    await fencing;
    await fence.query('ROLLBACK');
    held.release();
    fence.release();
  }
});

test('a held lower xid stops both consumers and is delivered before a later committed xid', async () => {
  const prefix = await append(access);
  const held = await access.connect(),
    later = await access.connect();
  try {
    await held.query('BEGIN');
    const low = (await held.query('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
    await later.query('BEGIN');
    const high = (await later.query('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
    expect(BigInt(high)).toBeGreaterThan(BigInt(low));
    const laterEvents = [await append(later), await append(later)];
    await later.query('COMMIT');
    // Assign lower-xid events their ids after the higher-xid events. Ordering
    // solely by identity, or filtering visible xids, would skip this writer.
    const heldEvents = [await append(held), await append(held)];
    const { notices, correspondence, inbox, mail } = consumers();
    expect(await notices.runAccessOnce()).toBe(1);
    expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(1);
    expect(inbox).toEqual([prefix]);
    expect(mail).toEqual([prefix]);
    expect(await notices.runAccessOnce()).toBe(0);
    expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(0);
    await held.query('COMMIT');
    expect(await notices.runAccessOnce()).toBe(4);
    expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(4);
    expect(inbox).toEqual([prefix, ...heldEvents, ...laterEvents]);
    expect(mail).toEqual(inbox);
    expect(await notices.runAccessOnce()).toBe(0);
    expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(0);
  } finally {
    await held.query('ROLLBACK');
    await later.query('ROLLBACK');
    held.release();
    later.release();
  }
});

test('recovery epochs drain restored high xids before new lower xids without replaying consumed events', async () => {
  const { notices, correspondence, inbox, mail } = consumers();
  const consumed = await append(access);
  expect(await notices.runAccessOnce()).toBe(1);
  expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(1);
  const pending = await append(access);
  // A logical archive can contain xids far beyond the fresh cluster counter.
  await access.query(
    "UPDATE access.notification_producer_event SET xid = '9223372036854775808'::xid8 WHERE event_id = $1",
    [pending],
  );
  expect(await notices.runAccessOnce()).toBe(0);
  expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(0);
  const generation = await engageAccessRecoveryFence(access);
  await releaseAccessRecoveryFence(access, generation);
  const fresh = await append(access);
  expect(await notices.runAccessOnce()).toBe(2);
  expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(2);
  expect(inbox).toEqual([consumed, pending, fresh]);
  expect(mail).toEqual(inbox);
  expect(await notices.runAccessOnce()).toBe(0);
  expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(0);
});

test('each consumer independently delivers every event once within the unchanged tick bound', async () => {
  const writer = await access.connect();
  const events: string[] = [];
  try {
    await writer.query('BEGIN');
    for (let i = 0; i < PRODUCER_COST.accessEventsPerTick * 2 + 3; i++)
      events.push(await append(writer));
    await writer.query('COMMIT');
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
  const { notices, correspondence, inbox, mail } = consumers();
  expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(
    PRODUCER_COST.accessEventsPerTick,
  );
  expect(inbox).toEqual([]);
  expect(mail).toEqual(events.slice(0, PRODUCER_COST.accessEventsPerTick));
  for (const expected of [16, 16, 3, 0]) expect(await notices.runAccessOnce()).toBe(expected);
  for (const expected of [16, 3, 0])
    expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(expected);
  expect(inbox).toEqual(events);
  expect(mail).toEqual(events);
});

test('partial inbox intake and failed correspondence leave their cursor unchanged until retry completes', async () => {
  const event = await append(access);
  let complete = false;
  const notices = producer(async () => ({ complete }));
  const correspondence = producer();
  correspondence.setSafetyCorrespondence({
    enqueueDecision: async () => {
      throw new Error('intake unavailable');
    },
  });
  const cursors = async () =>
    (
      await access.query(`SELECT consumer,epoch::text,xid::text,id::text
    FROM access.notification_producer_cursor ORDER BY consumer`)
    ).rows;
  const before = await cursors();
  expect(await notices.runAccessOnce()).toBe(1);
  await expect(correspondence.runSafetyCorrespondenceOnce()).rejects.toThrow('intake unavailable');
  expect(await cursors()).toEqual(before);
  complete = true;
  const delivered: string[] = [];
  correspondence.setSafetyCorrespondence({
    enqueueDecision: async (id) => {
      delivered.push(id);
    },
  });
  expect(await notices.runAccessOnce()).toBe(1);
  expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(1);
  expect(delivered).toEqual([event]);
  expect(await notices.runAccessOnce()).toBe(0);
  expect(await correspondence.runSafetyCorrespondenceOnce()).toBe(0);
});

test('concurrent ticks lock only their own consumer cursor and never deliver an event twice', async () => {
  const event = await append(access);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: string[] = [];
  const first = producer(async (notice) => {
    delivered.push(notice.subject.ref);
    entered();
    await hold;
    return [];
  });
  const second = producer(async (notice) => {
    delivered.push(notice.subject.ref);
    return [];
  });
  const running = first.runAccessOnce();
  try {
    await started;
    expect(await second.runAccessOnce()).toBe(0);
    const mail: string[] = [];
    second.setSafetyCorrespondence({
      enqueueDecision: async (id) => {
        mail.push(id);
      },
    });
    expect(await second.runSafetyCorrespondenceOnce()).toBe(1);
    expect(mail).toEqual([event]);
  } finally {
    release();
    await running;
  }
  expect(delivered).toEqual([event]);
  expect(await second.runAccessOnce()).toBe(0);
});

test('producer pages use a bounded index range at growing log sizes', async () => {
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    for (const size of [100, 1_000, 10_000]) {
      await client.query('TRUNCATE access.notification_producer_event');
      await client.query(
        `INSERT INTO access.notification_producer_event (epoch,xid,kind,event_id)
        SELECT generation,'0'::xid8,'moderation_outcome',gen_random_uuid()
        FROM access.recovery_fence CROSS JOIN generate_series(1,$1) WHERE id`,
        [size],
      );
      await client.query('ANALYZE access.notification_producer_event');
      const cursor = (
        await client.query(
          `SELECT epoch::text,xid::text,id::text
        FROM access.notification_producer_event ORDER BY epoch,xid,id OFFSET $1 LIMIT 1`,
          [size - 33],
        )
      ).rows[0]!;
      const plan = (
        await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${notificationProducerEventsSql}`, [
          cursor.epoch,
          cursor.xid,
          cursor.id,
          PRODUCER_COST.accessEventsPerTick,
        ])
      ).rows[0]!['QUERY PLAN'][0].Plan;
      const nodes: Record<string, unknown>[] = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
      };
      visit(plan);
      const range = nodes.find(
        (node) => node['Index Name'] === 'notification_producer_event_order',
      );
      expect(range).toBeDefined();
      expect(range!['Index Cond']).toContain('ROW(epoch, xid, id) >');
      expect(range!['Index Cond']).toContain('ROW(epoch, xid) <');
      expect(range!['Actual Rows']).toBe(PRODUCER_COST.accessEventsPerTick);
      expect(nodes.some((node) => node['Node Type'] === 'Sort')).toBe(false);
      expect(plan['Actual Rows']).toBe(PRODUCER_COST.accessEventsPerTick);
    }
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
