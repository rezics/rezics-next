import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { randomUUID } from 'node:crypto';
import { createReplyNoticeEffect } from '../../src/content/reply-notices.ts';
import { effectWorkflowId, launchWork, registerEffects, shutdownWork } from '../../src/events/effects.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, seed, type Population } from '../support/growth.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

let f: Awaited<ReturnType<typeof replyNoticeFixture>>;
beforeAll(async () => {
  f = await replyNoticeFixture();
});
afterAll(async () => {
  await f?.close();
});

test('reply notices use constant rows per post at 64, 256 and 1024 posts per thread', async () => {
  const thread = await f.thread();
  const sample = await f.post(thread.id);
  const route = routeOf(thread.id)!;
  const postRow = (
    await f.db.admin.query('SELECT * FROM content.post WHERE route=$1 AND thread_id=$2 AND post_id=$3', [
      route,
      thread.id,
      sample.id,
    ])
  ).rows[0]!;
  const revision = (
    await f.db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND thread_id=$2 AND revision_id=$3', [
      route,
      thread.id,
      sample.revisionId,
    ])
  ).rows[0]!;
  const population: Population = {
    name: `reply-notices-${randomUUID()}`,
    hotPartition: route >>> 4,
    hotShare: 1,
    rows: () => {
      const postId = newId(route),
        revisionId = newId(route);
      return {
        'content.post': [{ ...postRow, post_id: postId, head_revision_id: revisionId }],
        'content.revision': [{ ...revision, post_id: postId, revision_id: revisionId }],
      };
    },
  };
  let event: CloudEvent;
  let postId: string;
  const effect = createReplyNoticeEffect(f.db.pool, f.accounts.access);
  async function prepare() {
    const post = await f.post(thread.id);
    postId = post.id;
    event = (await f.envelope(postId)).events.find(Boolean)!;
  }
  const report = await checkGrowth(f.db, {
    name: 'Reply notices per post',
    scales: [64, 256, 1024],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    grow: async (db, scale, previous) => {
      await seed(db, population, { from: previous, to: scale });
    },
    prepare,
    warmup: async () => {
      await prepare();
      await effect.run(event);
    },
    operation: async () => {
      await effect.run(event);
      return postId;
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 256, 1024]);
  expect(await f.notices(postId!)).toHaveLength(1);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.statements).toBeGreaterThan(0);
  }
}, 300_000);

test('denied Access and completed-suppression redrives stay bounded as recipient history grows', async () => {
  const recipient = f.accounts.recipient;
  const recipientRoute = routeOf(recipient)!;
  const thread = await f.thread();
  const effects = contentNoticeEffects(
    f.db.pool,
    createContentWorkAccess(() => new Date(), f.db.pool),
  );
  const effect = effects.find((item) => item.name === 'content_reply_notice');
  expect(effect).toBeDefined();
  const scales = [64, 256, 1024] as const;
  const configure = async (reason: 'access' | 'preference') => {
    const post = await f.post(thread.id);
    const event = (await f.envelope(post.id)).events.find(Boolean)!;
    if (reason === 'access') {
      await f.db.admin.query(
        `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
         VALUES($1,$2,$3,'post:read','resource','(,)',$3)`,
        [routeOf(post.id), post.id, recipient],
      );
    } else {
      const current = await f.call(recipient, 'GET', `/v1/accounts/${recipient}/preferences`);
      expect(current.status).toBe(200);
      const update = await f.call(recipient, 'PATCH', `/v1/accounts/${recipient}/preferences`, {
        expectedVersion: current.value.version,
        notifications: { reply: false },
      });
      if (update.status !== 200)
        throw new Error(`Accounts preference update failed (${update.status}): ${JSON.stringify(update.value)}`);
    }
    return { postId: post.id, event };
  };
  for (const reason of ['access', 'preference'] as const) {
    let selected: Awaited<ReturnType<typeof configure>> | undefined;
    const report = await checkGrowth(f.db, {
      name: `Reply notice ${reason} suppression and completed redrive`,
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      warmups: 1,
      grow: async (_db, scale, previous) => {
        const ids = Array.from({ length: scale - previous }, () => newId(recipientRoute));
        await f.db.admin.query(
          `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
           SELECT $1,$2,id,'moderation_decision',id,'2026-10-01T00:00:00Z'::timestamptz +
                  ordinality * interval '1 millisecond'
           FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
          [recipientRoute, recipient, ids],
        );
      },
      warmup: async () => {
        const warm = await configure(reason);
        await effect!.run(warm.event);
      },
      prepare: async () => {
        selected = await configure(reason);
        if (reason === 'preference') await effect!.run(selected.event);
      },
      operation: async () => {
        if (!selected) throw new Error('Reply suppression event was not prepared');
        await effect!.run(selected.event);
        expect(await f.notices(selected.postId)).toEqual([]);
        const finalized = await f.db.admin.query<{ sent: boolean }>(
          `SELECT sent FROM content.notice_finalization WHERE route=$1 AND recipient_id=$2 AND kind='reply' AND source_id=$3`,
          [recipientRoute, recipient, selected.postId],
        );
        expect(finalized.rows).toEqual([{ sent: false }]);
        return selected.postId;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
    console.info(JSON.stringify(report));
  }
}, 300_000);

test('reply finalization waits for a paused native preference writer at the recipient partition fence', async () => {
  const native = await replyNoticeFixture();
  const recipient = native.accounts.recipient;
  const recipientRoute = routeOf(recipient)!;
  const gateClass = 91827;
  const gateObject = 61204;
  const suffix = randomUUID().replaceAll('-', '');
  const trigger = `pause_notice_preference_${suffix}`;
  const fn = `pause_notice_preference_${suffix}`;
  let gate: Awaited<ReturnType<typeof native.db.pool.connect>> | undefined;
  let preferenceWrite: Promise<{ status: number; value: unknown }> | undefined;
  let setupCreated = false;
  try {
    const thread = await native.thread();
    const effect = createReplyNoticeEffect(native.db.pool, native.accounts.access);
    await native.db.admin.query(
      `CREATE FUNCTION content.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN PERFORM pg_advisory_xact_lock(${gateClass},${gateObject}); RETURN NEW; END $$`,
    );
    await native.db.admin.query(
      `CREATE TRIGGER ${trigger} BEFORE INSERT OR UPDATE ON access.account_preferences
       FOR EACH ROW EXECUTE FUNCTION content.${fn}()`,
    );
    setupCreated = true;
    const waitFor = async (query: string, detail: string) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        const result = await native.db.admin.query<{ waiting: boolean }>(query);
        if (result.rows[0]?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${detail}`);
    };
    let selected:
      | { postId: string; event: NonNullable<Awaited<ReturnType<typeof native.envelope>>['events'][number]> }
      | undefined;
    const report = await checkGrowth(native.db, {
      name: 'Reply finalization at a paused recipient preference fence',
      scales: [64, 256, 1024],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      warmups: 1,
      grow: async (_db, scale, previous) => {
        const ids = Array.from({ length: scale - previous }, () => newId(recipientRoute));
        await native.db.admin.query(
          `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
           SELECT $1,$2,id,'moderation_decision',id,'2026-10-01T00:00:00Z'::timestamptz +
                  ordinality * interval '1 millisecond'
           FROM unnest($3::uuid[]) WITH ORDINALITY AS n(id,ordinality)`,
          [recipientRoute, recipient, ids],
        );
      },
      warmup: async () => {
        const post = await native.post(thread.id);
        const event = (await native.envelope(post.id)).events.find(Boolean)!;
        await effect.run(event);
      },
      prepare: async () => {
        const post = await native.post(thread.id);
        selected = { postId: post.id, event: (await native.envelope(post.id)).events.find(Boolean)! };
        gate = await native.db.pool.connect();
        await gate.query('SELECT pg_advisory_lock($1,$2)', [gateClass, gateObject]);
        const current = await native.call(recipient, 'GET', `/v1/accounts/${recipient}/preferences`);
        expect(current.status).toBe(200);
        preferenceWrite = native.call(recipient, 'PATCH', `/v1/accounts/${recipient}/preferences`, {
          expectedVersion: current.value.version,
          notifications: { reply: false },
        });
        await waitFor(
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=${gateClass}::oid AND
                         objid=${gateObject}::oid AND objsubid=2 AND granted=false) AS waiting`,
          'the native preference writer to pause after acquiring its partition fence',
        );
      },
      operation: async () => {
        if (!selected || !gate || !preferenceWrite) throw new Error('Paused preference writer was not prepared');
        const delivery = effect.run(selected.event);
        await waitFor(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND
                         query ILIKE '%core.partition%' AND pid<>pg_backend_pid()) AS waiting`,
          'notice finalization to wait on the recipient partition fence',
        );
        const held = gate;
        gate = undefined;
        held.release(true);
        const updated = await preferenceWrite;
        preferenceWrite = undefined;
        if (updated.status !== 200)
          throw new Error(`Accounts preference update failed (${updated.status}): ${JSON.stringify(updated.value)}`);
        await delivery;
        return selected.postId;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 256, 1024]);
    expect(await native.notices(selected!.postId)).toEqual([]);
    console.info(JSON.stringify(report));
  } finally {
    if (gate) gate.release(true);
    if (preferenceWrite) await preferenceWrite.catch(() => undefined);
    if (setupCreated) {
      await native.db.admin.query(`DROP TRIGGER IF EXISTS ${trigger} ON access.account_preferences`);
      await native.db.admin.query(`DROP FUNCTION IF EXISTS content.${fn}()`);
    }
    await native.close();
  }
}, 300_000);

test('registered reply effect runner stays bounded at the existing three scales', async () => {
  const native = await replyNoticeFixture();
  let launched = false;
  try {
    const thread = await native.thread();
    const sample = await native.post(thread.id);
    const route = routeOf(thread.id)!;
    const postRow = (
      await native.db.admin.query('SELECT * FROM content.post WHERE route=$1 AND thread_id=$2 AND post_id=$3', [
        route,
        thread.id,
        sample.id,
      ])
    ).rows[0]!;
    const revision = (
      await native.db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND thread_id=$2 AND revision_id=$3', [
        route,
        thread.id,
        sample.revisionId,
      ])
    ).rows[0]!;
    const effect = createReplyNoticeEffect(native.db.pool, native.accounts.access);
    const registered = registerEffects([effect], native.db.pool);
    await launchWork({ databaseUrl: native.db.url, systemDatabasePool: native.db.pool });
    launched = true;
    const deliver = async (postId: string) => {
      const envelope = await native.envelope(postId);
      const eventIndex = envelope.events.findIndex(Boolean);
      await registered.enqueue([envelope]);
      await DBOS.retrieveWorkflow(effectWorkflowId(envelope, eventIndex, 'content_reply_notice')).getResult();
    };
    let selectedPost: string | undefined;
    const createSelected = async () => {
      const post = await native.post(thread.id);
      selectedPost = post.id;
      return post.id;
    };
    const report = await checkGrowth(native.db, {
      name: 'Registered reply effect runner replay cost',
      scales: [64, 256, 1024],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      warmups: 1,
      grow: async (db, scale, previous) => {
        const count = scale - previous;
        const postIds = Array.from({ length: count }, () => newId(route));
        const revisionIds = postIds.map(() => newId(route));
        if (count === 0) return;
        await db.admin.query(
          `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,
                                   security_revision,recorded_transaction_id)
           SELECT $1,$2,posts.post_id,$4,posts.revision_id,'published',1,posts.post_id
           FROM unnest($3::uuid[],$5::uuid[]) AS posts(post_id,revision_id)`,
          [route, thread.id, postIds, postRow.author_account_id, revisionIds],
        );
        await db.admin.query(
          `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,
                                        subject_ids,board_id,availability,recorded_transaction_id)
           SELECT $1,$2,posts.post_id,posts.revision_id,$4,$5,'','MIT','{}',$6,'available',posts.post_id
           FROM unnest($3::uuid[],$7::uuid[]) AS posts(post_id,revision_id)`,
          [route, thread.id, postIds, revision.body, revision.body_sha256, revision.board_id, revisionIds],
        );
      },
      warmup: async () => {
        await deliver(await createSelected());
      },
      prepare: async () => {
        await createSelected();
      },
      operation: async () => {
        if (!selectedPost) throw new Error('Registered reply event was not prepared');
        await deliver(selectedPost);
        return selectedPost;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 256, 1024]);
    expect(await native.notices(selectedPost!)).toHaveLength(1);
    console.info(JSON.stringify(report));
  } finally {
    if (launched) await shutdownWork();
    await native.close();
  }
}, 300_000);
