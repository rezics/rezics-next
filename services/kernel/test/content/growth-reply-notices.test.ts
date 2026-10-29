import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createReplyNoticeEffect } from '../../src/content/reply-notices.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { checkGrowth, seed, type Population } from '../support/growth.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { replyNoticeFixture } from './support/reply-notice-fixture.ts';

let f: Awaited<ReturnType<typeof replyNoticeFixture>>;
beforeAll(async () => { f = await replyNoticeFixture(); });
afterAll(async () => { await f?.close(); });

test('reply notices use constant rows per post at 64, 256 and 1024 posts per thread', async () => {
  const thread = await f.thread();
  const sample = await f.post(thread.id);
  const route = routeOf(thread.id)!;
  const postRow = (await f.db.admin.query('SELECT * FROM content.post WHERE route=$1 AND thread_id=$2 AND post_id=$3', [route, thread.id, sample.id])).rows[0]!;
  const revision = (await f.db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND thread_id=$2 AND revision_id=$3', [route, thread.id, sample.revisionId])).rows[0]!;
  const population: Population = {
    name: `reply-notices-${randomUUID()}`, hotPartition: route >>> 4, hotShare: 1,
    rows: () => {
      const postId = newId(route), revisionId = newId(route);
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
    name: 'Reply notices per post', scales: [64, 256, 1024],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' }, repetitions: 1,
    grow: async (db, scale, previous) => { await seed(db, population, { from: previous, to: scale }); },
    prepare,
    warmup: async () => { await prepare(); await effect.run(event); },
    operation: async () => { await effect.run(event); return postId; },
  });
  expect(report.samples.map(sample => sample.scale)).toEqual([64, 256, 1024]);
  expect(await f.notices(postId!)).toHaveLength(1);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.statements).toBeGreaterThan(0);
  }
}, 300_000);
