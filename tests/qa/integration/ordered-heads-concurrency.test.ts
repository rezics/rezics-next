import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import {
  appendContentEvent,
  sequenceContentEvents,
} from '../../../services/content/src/event-sequencer.ts';
import {
  engageAccessRecoveryFence,
  releaseAccessRecoveryFence,
} from '../../../services/main/src/modules/access/admission.ts';
import { EditorialReviewStore } from '../../../services/main/src/modules/editorial-review/store.ts';
import { ReadingPositionStore } from '../../../services/main/src/modules/reading-position/store.ts';
import { RealmDirectoryIndex } from '../../../services/main/src/modules/realm-directory/index.ts';
import {
  ReadRankingProjection,
  RankingProjectionUnavailable,
} from '../../../services/main/src/modules/rankings/projection.ts';
import { StructureProgressStore } from '../../../services/main/src/modules/progress/store.ts';
import type { WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { SafetyQueue } from '../../../services/main/src/modules/safety-queue/store.ts';
import {
  GovernanceStore,
  GovernanceDenied,
} from '../../../services/main/src/modules/governance/store.ts';
import { NotificationProducer } from '../../../services/main/src/modules/notification-producers/producer.ts';
import { WorkReadMoved } from '../../../services/main/src/modules/work/read-session.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let access: Pool, content: Pool;
const native = () => `https://rezics.com/id/${randomUUID()}`;
const principal = { issuer: 'https://ordered-heads.test', subject: randomUUID() };
const principalId = randomUUID(),
  actor = native();

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
  databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access', 'content']);
  access = new Pool({ connectionString: databases.urls.access, max: 8 });
  content = new Pool({ connectionString: databases.urls.content, max: 8 });
  await migrateContent(content);
  await access.query(
    'INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject],
  );
  await access.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [actor]);
}, 30_000);

afterAll(async () => {
  await access?.end();
  await content?.end();
  await databases?.close();
});

async function begin(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '750ms'");
  await client.query("SET LOCAL statement_timeout = '900ms'");
  // Identity allocation and transaction allocation can occur in either order.
  await client.query('SELECT pg_current_xact_id()');
  return client;
}
async function close(client: PoolClient) {
  await client.query('ROLLBACK');
  client.release();
}
async function commitWithinSecond(client: PoolClient, write: () => Promise<unknown>) {
  const started = performance.now();
  await write();
  await client.query('COMMIT');
  expect(performance.now() - started).toBeLessThan(1_000);
}
const sequence = async (owner: 'reader_review_ranks' | 'editorial_events') =>
  (
    await access.query<{ assigned: number | null }>(
      `SELECT access.sequence_${owner}(100) AS assigned`,
    )
  ).rows[0]!.assigned;

async function review(client: PoolClient, work: string, deleted = false) {
  const row = randomUUID();
  await client.query(
    `INSERT INTO access.reader_review
    (id,principal_id,acting_subject,context,work,language,body,spoiler,revision,deleted)
    VALUES ($1,$2,$3,$4,$5,'en','A review',false,$6,$7)`,
    [row, principalId, actor, native(), work, randomUUID(), deleted],
  );
  return row;
}

test('review rank writers commit independently and the sequencer never skips a late lower xid', async () => {
  await sequence('reader_review_ranks');
  const head = (
    await access.query('SELECT position::text FROM access.reader_review_rank_head WHERE singleton')
  ).rows[0]!.position;
  const held = await begin(access),
    later = await begin(access);
  const heldWork = native(),
    laterWork = native();
  try {
    await commitWithinSecond(later, () => review(later, laterWork));
    // The lower xid gets its identity after the higher xid has already committed.
    const heldReview = await review(held, heldWork);
    expect(await sequence('reader_review_ranks')).toBe(0);
    await held.query('COMMIT');
    expect(await sequence('reader_review_ranks')).toBe(2);
    const rows = (
      await access.query(
        `SELECT work,position::text FROM access.reader_review_rank_change
      WHERE position > $1 ORDER BY position`,
        [head],
      )
    ).rows;
    expect(rows).toEqual([
      { work: heldWork, position: String(BigInt(head) + 1n) },
      { work: laterWork, position: String(BigInt(head) + 2n) },
    ]);
    expect(await sequence('reader_review_ranks')).toBe(0);
    const deleting = await begin(access),
      other = await begin(access);
    try {
      await deleting.query(
        'UPDATE access.reader_review SET deleted = true,revision = $2 WHERE id = $1',
        [heldReview, randomUUID()],
      );
      await commitWithinSecond(other, () => review(other, native()));
      await deleting.query('COMMIT');
      expect(await sequence('reader_review_ranks')).toBe(2);
      expect(
        (
          await access.query(
            `SELECT delta FROM access.reader_review_rank_change
        WHERE work = $1 ORDER BY position`,
            [heldWork],
          )
        ).rows,
      ).toEqual([{ delta: 1 }, { delta: -1 }]);
    } finally {
      await close(deleting);
      await close(other);
    }
  } finally {
    await close(held);
    await close(later);
  }
});

async function proposal(): Promise<string> {
  const id = randomUUID();
  await access.query(
    `INSERT INTO access.editorial_proposal
    (id,kind,target,resource,context,proposer_principal,proposer_agent,proposer_key,proposer_controllers)
    VALUES ($1,'correction','{}',$2,$3,$4,$5,$6,ARRAY[$4::uuid])`,
    [id, native(), native(), principalId, actor, 'a'.repeat(64)],
  );
  return id;
}
async function editorial(client: PoolClient | Pool, id: string, xid?: string): Promise<string> {
  const event = randomUUID();
  await client.query(
    `INSERT INTO access.editorial_event(id,proposal,revision,kind,actor,xid)
    VALUES ($1,$2,1,'created',$3,COALESCE($4::xid8,pg_current_xact_id()))`,
    [event, id, actor, xid ?? null],
  );
  return event;
}

test('editorial writers commit independently and timeline consumers retain the held event', async () => {
  const proposals = [await proposal(), await proposal()];
  const store = new EditorialReviewStore(access);
  await sequence('editorial_events');
  const head = (
    await access.query('SELECT sequence::text FROM access.editorial_event_clock WHERE id')
  ).rows[0]!.sequence;
  const held = await begin(access),
    later = await begin(access);
  try {
    let high = '';
    await commitWithinSecond(later, async () => {
      high = await editorial(later, proposals[1]!);
    });
    const low = await editorial(held, proposals[0]!);
    expect(await sequence('editorial_events')).toBe(0);
    expect(await store.eventsAfter(head)).toEqual([]);
    await held.query('COMMIT');
    expect(await sequence('editorial_events')).toBe(2);
    const events = await store.eventsAfter(head);
    expect(events.map((event) => event.id)).toEqual([low, high]);
    expect(events.map((event) => event.sequence)).toEqual([
      String(BigInt(head) + 1n),
      String(BigInt(head) + 2n),
    ]);
    expect(await store.eventsAfter(events.at(-1)!.sequence)).toEqual([]);
    await expect(
      access.query('UPDATE access.editorial_event SET kind = $2 WHERE id = $1', [low, 'revised']),
    ).rejects.toMatchObject({ code: '23514' });
  } finally {
    await close(held);
    await close(later);
  }
});

test('recovery drains restored pending high xids without renumbering or replaying prior events', async () => {
  const id = await proposal();
  const consumed = await editorial(access, id);
  await sequence('editorial_events');
  const consumedPosition = (
    await access.query('SELECT sequence::text FROM access.editorial_event WHERE id = $1', [
      consumed,
    ])
  ).rows[0]!.sequence;
  const pending = await editorial(access, id, '9223372036854775808');
  const work = native();
  await access.query(
    `INSERT INTO access.reader_review_rank_change(epoch,xid,work,occurred_at,delta)
    SELECT generation,'9223372036854775808'::xid8,$1,now(),1 FROM access.recovery_fence WHERE id`,
    [work],
  );
  expect(await sequence('editorial_events')).toBe(0);
  expect(await sequence('reader_review_ranks')).toBe(0);
  const generation = await engageAccessRecoveryFence(access);
  await releaseAccessRecoveryFence(access, generation);
  const fresh = await editorial(access, id);
  expect(await sequence('editorial_events')).toBe(2);
  expect(await sequence('reader_review_ranks')).toBe(1);
  expect(
    (await new EditorialReviewStore(access).eventsAfter(consumedPosition)).map((event) => event.id),
  ).toEqual([pending, fresh]);
  expect(
    (
      await access.query('SELECT sequence::text FROM access.editorial_event WHERE id = $1', [
        consumed,
      ])
    ).rows[0]!.sequence,
  ).toBe(consumedPosition);
});

async function realm(): Promise<string> {
  const id = native();
  await access.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'institution')", [
    id,
  ]);
  await access.query(
    "INSERT INTO access.membership_policy(kind,owner_subject,revision,terms_revision) VALUES ('realm',$1,0,'terms')",
    [id],
  );
  return id;
}
async function join(client: PoolClient, id: string, privateMember: boolean) {
  if (privateMember) {
    const consent = randomUUID();
    await client.query(
      `INSERT INTO access.private_membership_consent
      (id,principal_id,principal_epoch,kind,owner_subject,next_generation,policy_revision,terms_revision,expires_at)
      VALUES ($1,$2,0,'realm',$3,1,0,'terms',now() + interval '5 minutes')`,
      [consent, principalId, id],
    );
    await client.query(
      `INSERT INTO access.private_membership
    (id,kind,owner_subject,principal_id,state,generation,policy_revision,terms_revision,consent_reference)
    VALUES ($1,'realm',$2,$3,'joined',1,0,'terms',$4)`,
      [randomUUID(), id, principalId, consent],
    );
  } else
    await client.query(
      `INSERT INTO access.membership
    (id,kind,owner_subject,member_subject,state,generation,policy_revision,terms_revision,consent_reference)
    VALUES ($1,'realm',$2,$3,'joined',1,0,'terms','consent')`,
      [randomUUID(), id, actor],
    );
}
async function report(client: PoolClient, target: string) {
  await client.query(
    `INSERT INTO access.governance_case
    (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
    VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','graph',$2,'body','parties')`,
    [randomUUID(), target],
  );
}
async function post(client: PoolClient, id: string) {
  const item = native();
  await client.query(
    `INSERT INTO access.feed_item(data_epoch,id,sequence,kind,occurred_at,time_basis,best_key,
    realm,group_bucket,group_key,group_leader,group_members,sort_time)
    VALUES ('ordered-heads',$1,1,'discussion',now(),'relay',1,$2,'day',$1,true,ARRAY[$1],now())`,
    [item, id],
  );
}

for (const [name, write, read] of [
  [
    'site moderation',
    report,
    async () =>
      (await access.query('SELECT access.site_moderation_basis() AS basis')).rows[0]!.basis,
  ],
  [
    'Realm count',
    (client: PoolClient, id: string) => join(client, id, false),
    async () => (await access.query('SELECT access.realm_count_basis() AS basis')).rows[0]!.basis,
  ],
  [
    'Realm growth',
    post,
    async () => (await access.query('SELECT access.realm_growth_basis() AS basis')).rows[0]!.basis,
  ],
] as const) {
  test(`${name} writers commit independently and the read fence detects late commits while xmin stays pinned`, async () => {
    const targets = [await realm(), await realm()];
    const oldest = await begin(access),
      held = await begin(access),
      later = await begin(access);
    try {
      await write(held, targets[0]!);
      await commitWithinSecond(later, () => write(later, targets[1]!));
      const before = await read();
      await held.query('COMMIT');
      expect(await read()).not.toBe(before);
      if (name === 'Realm count') {
        await expect(new RealmDirectoryIndex(access).fence(before)).rejects.toBeInstanceOf(
          WorkReadMoved,
        );
        expect(
          (
            await access.query(
              'SELECT value::text FROM access.realm_member_count WHERE realm = ANY($1) ORDER BY realm',
              [targets],
            )
          ).rows,
        ).toEqual([{ value: '1' }, { value: '1' }]);
      }
      if (name === 'site moderation') {
        const page = await new SafetyQueue(access, async () => ({ principalId })).page(principal, {
          actingSubject: actor,
        });
        expect(page.items.some((item) => item.target?.resource === targets[0])).toBe(true);
      }
      await oldest.query('ROLLBACK');
      const stable = await read();
      await access.query('SELECT pg_current_xact_id()');
      expect(await read()).toBe(stable);
    } finally {
      await close(oldest);
      await close(held);
      await close(later);
    }
  });
}

test('private Realm joins keep independent counts and both count and growth read fences', async () => {
  const targets = [await realm(), await realm()];
  const held = await begin(access),
    later = await begin(access);
  try {
    await join(held, targets[0]!, true);
    await commitWithinSecond(later, () => join(later, targets[1]!, true));
    const before = (
      await access.query(
        'SELECT access.realm_count_basis() AS count,access.realm_growth_basis() AS growth',
      )
    ).rows[0]!;
    await held.query('COMMIT');
    const after = (
      await access.query(
        'SELECT access.realm_count_basis() AS count,access.realm_growth_basis() AS growth',
      )
    ).rows[0]!;
    expect(after.count).not.toBe(before.count);
    expect(after.growth).not.toBe(before.growth);
  } finally {
    await close(held);
    await close(later);
  }
});

test('bulk revelation writes append one change and an unrelated writer commits within one second', async () => {
  const store = new ReadingPositionStore(content);
  const row = () => ({
    record: native(),
    recordKind: 'statement' as const,
    continuityWork: native(),
    occurrence: native(),
    receipt: randomUUID(),
  });
  const oldest = await begin(content),
    held = await begin(content),
    later = await begin(content);
  const low = row(),
    high = row();
  try {
    await store.write(held, low, null);
    for (let i = 0; i < 32; i++) await store.write(held, row(), null);
    await commitWithinSecond(later, () => store.write(later, high, null));
    const before = await store.generation();
    expect((await store.lookup([low.record, high.record])).has(low.record)).toBe(false);
    await held.query('COMMIT');
    expect(await store.generation()).not.toBe(before);
    expect((await store.lookup([low.record, high.record])).size).toBe(2);
    expect(
      (await content.query('SELECT count(*)::integer AS count FROM reading_position.change'))
        .rows[0]!.count,
    ).toBe(2);
    await oldest.query('ROLLBACK');
    const stable = await store.generation();
    await content.query('SELECT pg_current_xact_id()');
    expect(await store.generation()).toBe(stable);
  } finally {
    await close(oldest);
    await close(held);
    await close(later);
  }
});

test('unrelated Content writes leave old rankings current and consume no ranking tick budget', async () => {
  const core = new ContentCore(content);
  const owner = await core.ownerPosition(),
    generation = randomUUID();
  const reviewHead = (
    await access.query('SELECT position::text FROM access.reader_review_rank_head WHERE singleton')
  ).rows[0]!.position;
  await access.query(
    `INSERT INTO access.read_ranking_checkpoint
    (singleton,generation,content_epoch,content_sequence,graph_epoch,review_position,updated_at)
    VALUES (true,$1,$2,0,'ranking-graph',$3,now() - interval '2 minutes')`,
    [generation, owner.dataEpoch, reviewHead],
  );
  const env = {
    lineage: { dataEpoch: 'ranking-graph' },
    fuseki: {
      query: async () => {
        throw new Error('Unrelated writes must not rebuild or hydrate rankings');
      },
    },
  } as unknown as WorkActivationEnvironment;
  const projection = new ReadRankingProjection(access, core, content, env);
  const client = await content.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < 65; i++)
      await appendContentEvent(client, {
        operationId: randomUUID(),
        requestDigest: 'a'.repeat(64),
        action: 'comment.create',
        outcome: 'succeeded',
        eventType: 'comment.created',
        recipe: 'reader-comment-v1',
        payload: {},
      });
    await client.query('COMMIT');
    await sequenceContentEvents(content);
    expect((await core.ownerPosition()).sequence).not.toBe(owner.sequence);
    expect((await projection.current()).generation).toBe(generation);
    expect(await projection.tick()).toBe(0);
    expect((await projection.current()).contentSequence).toBe('0');
    const progress = new StructureProgressStore(content);
    for (let i = 0; i < 35; i++)
      await progress.write({
        principal,
        structure: native(),
        occurrence: native(),
        selectedRevision: `urn:rezics:content:revision:${randomUUID()}`,
        completed: true,
        position: null,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      });
    // Relevant progress still outdates the checkpoint even after many unrelated events.
    await expect(projection.current()).rejects.toBeInstanceOf(RankingProjectionUnavailable);
    const last = (await core.ownerPosition()).sequence;
    await access.query(
      "UPDATE access.read_ranking_checkpoint SET content_sequence = $1,updated_at = now() - interval '2 minutes'",
      [String(BigInt(last) - 1n)],
    );
    // The final progress position crosses 99 to 100. A text-alias sort would
    // choose 99 as the head and incorrectly declare this checkpoint current.
    await expect(projection.current()).rejects.toBeInstanceOf(RankingProjectionUnavailable);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('sequencer locks and rolled-back writers neither block appends nor leave delivery gaps', async () => {
  const id = await proposal(),
    writer = await begin(access),
    holder = await begin(access);
  const work = native();
  try {
    await holder.query('SELECT 1 FROM access.reader_review_rank_head WHERE singleton FOR UPDATE');
    await holder.query('SELECT 1 FROM access.editorial_event_clock WHERE id FOR UPDATE');
    await commitWithinSecond(writer, async () => {
      await review(writer, work);
      await editorial(writer, id);
    });
    expect(await sequence('reader_review_ranks')).toBeNull();
    expect(await sequence('editorial_events')).toBeNull();
    await holder.query('ROLLBACK');
    const aborted = await begin(access),
      later = await begin(access);
    let committed = '';
    try {
      const lost = await editorial(aborted, id);
      await review(aborted, native());
      await commitWithinSecond(later, async () => {
        committed = await editorial(later, id);
        await review(later, native());
      });
      await aborted.query('ROLLBACK');
      expect(await sequence('reader_review_ranks')).toBe(2);
      expect(await sequence('editorial_events')).toBe(2);
      expect(
        (await access.query('SELECT id FROM access.editorial_event WHERE id = $1', [lost])).rows,
      ).toEqual([]);
      expect(
        (
          await access.query('SELECT sequence FROM access.editorial_event WHERE id = $1', [
            committed,
          ])
        ).rows[0]!.sequence,
      ).not.toBeNull();
    } finally {
      await close(aborted);
      await close(later);
    }
  } finally {
    await close(writer);
    await close(holder);
  }
});

test('change fences use bounded index probes as histories grow', async () => {
  for (const [pool, schema, table, basis, index] of [
    [
      access,
      'access',
      'site_moderation_change',
      'site_moderation_basis',
      'site_moderation_change_order',
    ],
    [access, 'access', 'realm_count_change', 'realm_count_basis', 'realm_count_change_order'],
    [access, 'access', 'realm_growth_change', 'realm_growth_basis', 'realm_growth_change_order'],
    [content, 'reading_position', 'change', 'current_generation', 'reading_position_change_order'],
  ] as const) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const sql = (
        await client.query<{ sql: string }>(
          'SELECT prosrc AS sql FROM pg_proc WHERE oid = $1::regprocedure',
          [`${schema}.${basis}()`],
        )
      ).rows[0]!.sql;
      for (const size of [100, 1_000, 10_000]) {
        await client.query(`TRUNCATE ${schema}.${table}`);
        await client.query(
          schema === 'access'
            ? `INSERT INTO access.${table}(epoch,xid) SELECT generation,'0'::xid8
            FROM access.recovery_fence CROSS JOIN generate_series(1,$1) WHERE id`
            : `INSERT INTO reading_position.change(data_epoch,xid) SELECT data_epoch,'0'::xid8
            FROM content.owner_control CROSS JOIN generate_series(1,$1) WHERE singleton`,
          [size],
        );
        await client.query(`ANALYZE ${schema}.${table}`);
        const plan = (await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`)).rows[0]![
          'QUERY PLAN'
        ][0].Plan;
        const nodes: Record<string, unknown>[] = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[]) visit(child);
        };
        visit(plan);
        const probes = nodes.filter((node) => node['Index Name'] === index);
        expect(probes).toHaveLength(2);
        expect(probes.every((node) => Number(node['Actual Rows']) <= 1)).toBe(true);
        expect(probes.every((node) => node['Index Cond'] !== undefined)).toBe(true);
        expect(nodes.some((node) => node['Node Type'] === 'Sort')).toBe(false);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
});

test('editorial notification cursor advances in numeric order across bounded ticks without skips or replay', async () => {
  const id = await proposal();
  const head = (
    await access.query('SELECT sequence::text FROM access.editorial_event_clock WHERE id')
  ).rows[0]!.sequence;
  await access.query(
    "UPDATE access.notification_producer_cursor SET position = $1 WHERE consumer = 'editorial-notification-v1'",
    [head],
  );
  for (let i = 0; i < 19; i++)
    await access.query(
      `INSERT INTO access.editorial_event(proposal,revision,kind,actor)
    VALUES ($1,1,'apply-pending',$2)`,
      [id, actor],
    );
  const producer = new NotificationProducer(
    access,
    null,
    content,
    {} as never,
    {
      enqueue: async () => {
        throw new Error('Delivery-progress events have no notification');
      },
    } as never,
    null,
  );
  expect(await producer.runEditorialOnce()).toBe(16);
  expect(
    (
      await access.query(
        "SELECT position::text FROM access.notification_producer_cursor WHERE consumer = 'editorial-notification-v1'",
      )
    ).rows[0]!.position,
  ).toBe(String(BigInt(head) + 16n));
  expect(await producer.runEditorialOnce()).toBe(3);
  expect(await producer.runEditorialOnce()).toBe(0);
  expect(
    (
      await access.query(
        "SELECT position::text FROM access.notification_producer_cursor WHERE consumer = 'editorial-notification-v1'",
      )
    ).rows[0]!.position,
  ).toBe(String(BigInt(head) + 19n));
});

test('safety read authority and pages stay unlocked and still deny a revoked staff grant', async () => {
  await access.query(
    `INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
    VALUES ($1,$2,$3,'agent.control','infinity')`,
    [randomUUID(), principalId, actor],
  );
  const grants = [randomUUID(), randomUUID(), randomUUID()];
  for (const [index, action] of [
    'governance.moderate',
    'governance.rights.decide',
    'governance.safety.evidence',
  ].entries())
    await access.query(
      `INSERT INTO access.permission_grant
      (id,issuer_subject,recipient_subject,scope_id,action,valid_until)
      VALUES ($1,$2,$2,'governance:platform',$3,now() + interval '1 hour')`,
      [grants[index], actor, action],
    );
  const queue = new GovernanceStore(access, {} as never, {} as never, {} as never).safety;
  const held = await begin(access);
  try {
    await held.query("SELECT 1 FROM access.scope_gate WHERE id = 'governance:platform' FOR UPDATE");
    await held.query('SELECT 1 FROM access.principal WHERE id = $1 FOR UPDATE', [principalId]);
    const started = performance.now();
    expect((await queue.page(principal, { actingSubject: actor })).items.length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(1_000);
    await held.query('ROLLBACK');
    await access.query('UPDATE access.permission_grant SET active = false WHERE id = ANY($1)', [
      grants,
    ]);
    await expect(queue.page(principal, { actingSubject: actor })).rejects.toBeInstanceOf(
      GovernanceDenied,
    );
  } finally {
    await close(held);
  }
});
