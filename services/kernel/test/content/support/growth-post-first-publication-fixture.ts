import { expect } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createKernel } from '../../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../../src/access/write-rate.ts';
import { threadTarget } from '../../../src/content/commands.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { openGrowthDatabase, seed, type Population } from '../../support/growth.ts';
import { testReceiptKeys } from '../../support/receipt-keys.ts';
import { postPublicationFixture, publicationType, type PublicationPost } from './post-publication-fixture.ts';

export const publicationScales = [256, 1024, 4096] as const;
export const publicationBody = fromPlainText('A fixed native first-publication body.');
export type PublicationKind = 'opening' | 'reply';
export type PublicationAxis = 'unrelated' | 'revisions' | 'history';
export type PublicationTarget = {
  threadId: string;
  post: PublicationPost;
  ancestry: number;
};

/** The original native Auth/Access composition supplies credentials and parents.
 * Only the pool changes: ordinary production HTTP runs on the shared observer. */
export async function growthPostFirstPublicationFixture() {
  const native = await postPublicationFixture();
  const db = await openGrowthDatabase(native.pool.options.connectionString);
  try {
    const kernel = createKernel({
      pool: db.pool,
      access: native.system.access,
      routeKey: native.system.routeKey,
      tokens: native.system.tokenKeys,
      receiptKeys: testReceiptKeys(),
      writeRate: createWriteRateLimiter({
        secret: 'native-first-publication-growth-write-rate-secret-32-bytes',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100_000, seconds: 86_400 } } }),
      }),
      ratePeer: () => '127.0.0.1',
    });
    async function call(
      method: string,
      path: string,
      body?: unknown,
      options: { key?: string; head?: string; other?: boolean; anonymous?: boolean } = {},
    ) {
      const response = await kernel.handle(new Request(`https://content.test${path}`, {
        method,
        headers: {
          ...(options.anonymous ? {} : {
            authorization: `Bearer ${(options.other ? native.system.actors.other : native.author).bearer}`,
          }),
          ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(options.key ?? crypto.randomUUID()) }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.head === undefined ? {} : { 'if-match': JSON.stringify(options.head) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      return { status: response.status, value: await response.json() as Record<string, any> };
    }
    async function checked(method: string, path: string, body: unknown, status: number, options = {}) {
      const result = await call(method, path, body, options);
      expect(result.status, JSON.stringify(result.value)).toBe(status);
      return result.value;
    }
    const scope = await native.thread();
    const home = partitionOf(routeOf(scope.id)!);
    const route = routeOf(scope.id)!;
    // The reply has exactly 32 parents, including the opening; the selected
    // draft is the 33rd post. No population changes this ancestry.
    let parent = scope.firstPost;
    for (let i = 1; i < 32; i++) parent = await native.reply(scope.id, 'published', parent.id);
    const [threadTemplate, postTemplate, revisionTemplate] = await Promise.all([
      db.admin.query('SELECT * FROM content.thread WHERE route=$1 AND thread_id=$2', [route, scope.id]),
      db.admin.query('SELECT * FROM content.post WHERE route=$1 AND post_id=$2', [route, scope.firstPost.id]),
      db.admin.query('SELECT * FROM content.revision WHERE route=$1 AND revision_id=$2', [route, scope.firstPost.revisionId]),
    ]);
    const unrelated: Population = {
      name: `first-publication-unrelated-${crypto.randomUUID()}`,
      hotPartition: home,
      hotShare: 1,
      rows: ({ route: placedRoute }) => {
        const threadId = newId(placedRoute), postId = newId(placedRoute), revisionId = newId(placedRoute);
        const transaction = crypto.randomUUID();
        return {
          'content.thread': [{ ...threadTemplate.rows[0], route: placedRoute, thread_id: threadId,
            first_post_id: postId, recorded_transaction_id: transaction }],
          'content.post': [{ ...postTemplate.rows[0], route: placedRoute, thread_id: threadId, post_id: postId,
            head_revision_id: revisionId, recorded_transaction_id: transaction }],
          'content.revision': [{ ...revisionTemplate.rows[0], route: placedRoute, thread_id: threadId, post_id: postId,
            revision_id: revisionId, recorded_transaction_id: transaction }],
        };
      },
    };
    async function draft(kind: PublicationKind, retained = 0): Promise<PublicationTarget> {
      let target: PublicationTarget;
      if (kind === 'reply') {
        const value = await checked('POST', `/v1/threads/${scope.id}/posts`, {
          body: publicationBody, licence: 'MIT', parentId: parent.id, visibility: 'draft',
        }, 201);
        target = { threadId: scope.id, post: value.post, ancestry: 33 };
      } else {
        let key: string;
        do { key = crypto.randomUUID(); }
        while (partitionOf(threadTarget(native.system.routeKey, native.author.actor.accountId, key).route) !== home);
        const value = await checked('POST', '/v1/threads', {
          title: 'First publication growth', body: publicationBody, licence: 'MIT', subjectIds: [],
          boardId: native.board.id, visibility: 'draft',
        }, 201, { key });
        target = { threadId: value.thread.id, post: value.thread.firstPost, ancestry: 1 };
      }
      expect(partitionOf(routeOf(target.post.id)!)).toBe(home);
      if (retained) {
        // Retained immutable versions only: never advance a head, change a
        // selected visibility, or manufacture a command receipt/event.
        const ids = Array.from({ length: retained }, () => newId(routeOf(target.post.id)!));
        await db.admin.query(`INSERT INTO content.revision
          (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,
           board_id,availability,recorded_transaction_id,recorded_at,media_ids,vote_citation)
          SELECT r.route,r.thread_id,r.post_id,ids.id,r.body,r.body_sha256,r.search_text,r.licence,r.subject_ids,
                 r.board_id,r.availability,r.recorded_transaction_id,r.recorded_at,r.media_ids,r.vote_citation
          FROM content.revision r CROSS JOIN unnest($3::uuid[]) AS ids(id)
          WHERE r.route=$1 AND r.revision_id=$2`, [routeOf(target.post.id), target.post.revisionId, ids]);
      }
      const state = await native.state(target.post.id);
      expect(state.visibility).toBe('draft');
      expect(state.head_revision_id).toBe(target.post.revisionId);
      expect(state.revisions).toBe(retained + 1);
      expect(await publications(target.post.id)).toEqual([]);
      return target;
    }
    const revise = (post: PublicationPost, body: Record<string, unknown> = { visibility: 'published' },
      options: Parameters<typeof call>[3] = {}) => call('POST', `/v1/posts/${post.id}/revisions`,
        { body: publicationBody, ...body }, { head: post.revisionId, ...options });
    const publications = async (id: string) => (await native.evidence(id)).filter(e => e.type === publicationType);
    async function snapshot(target: PublicationTarget) {
      const id = target.post.id;
      const [state, revisions, records] = await Promise.all([
        native.state(id),
        db.admin.query('SELECT revision_id FROM content.revision WHERE route=$1 AND post_id=$2 ORDER BY revision_id',
          [routeOf(id), id]),
        db.admin.query(`SELECT c.transaction_id,c.response,c.position::text,b.client_id,b.principal_id,
          (SELECT jsonb_agg(jsonb_build_object('type',o.type,'data',o.data) ORDER BY o.event_seq)
           FROM core.outbox o WHERE o.partition_no=c.partition_no AND o.position=c.position) AS events
          FROM core.receipt c JOIN editorial.write_basis b USING(partition_no,transaction_id)
          WHERE c.partition_no=$1 AND c.response->>'itemId'=$2 ORDER BY c.position`, [home, id]),
      ]);
      return { state, revisions: revisions.rows, records: records.rows, events: await native.evidence(id) };
    }
    async function assertPublished(target: PublicationTarget, revisionId: string, before: Awaited<ReturnType<typeof snapshot>>) {
      const after = await snapshot(target);
      expect(after.state).toMatchObject({
        visibility: 'published', head_revision_id: revisionId,
        security_revision: String(BigInt(before.state.security_revision) + 1n),
        thread_visibility: 'published',
        thread_security_revision: String(BigInt(before.state.thread_security_revision) + (target.ancestry === 1 ? 1n : 0n)),
        revisions: before.state.revisions + 1,
      });
      expect(after.records).toHaveLength(before.records.length + 1);
      const record = after.records.at(-1)!;
      expect(record).toMatchObject({ client_id: native.author.actor.clientId, principal_id: native.author.actor.accountId,
        response: { threadId: target.threadId, itemId: target.post.id, revisionId } });
      expect(record.events).toHaveLength(2);
      expect(record.events.map((e: { type: string }) => e.type)).toEqual([
        'com.rezics.content.revision.created.v1', publicationType,
      ]);
      expect(await publications(target.post.id)).toEqual([{ type: publicationType, data: {
        threadId: target.threadId, itemId: target.post.id, revisionId,
        actorId: native.author.actor.accountId, placeId: native.realm.realmId,
        kind: 'discussion', subjectIds: [], activityAt: expect.any(String),
      } }]);
      const exact = await call('GET', `/v1/posts/${target.post.id}/revisions/${revisionId}`);
      expect(exact.status).toBe(200);
      expect(exact.value.post.body).toEqual(publicationBody);
      return after;
    }
    const historySubject = native.system.actors.other.actor.accountId;
    async function grow(axis: PublicationAxis, scale: number, previous: number) {
      if (axis === 'unrelated') {
        await seed(db, unrelated, { from: previous, to: scale });
        for (const relation of ['thread', 'post']) {
          const count = await db.admin.query(`SELECT count(*)::integer AS n FROM content.${relation} WHERE route >> 4=$1`, [home]);
          expect(count.rows[0]!.n).toBeGreaterThanOrEqual(scale);
        }
      }
      if (axis === 'history') {
        for (let i = previous; i < scale; i++) {
          const start = new Date(Date.UTC(2000, 0, 1 + i)).toISOString();
          const end = new Date(Date.UTC(2000, 0, 2 + i)).toISOString();
          // Disjoint, expired grants to one unrelated real resource. Every
          // receipt, basis and outbox row is produced by the native grant API.
          await checked('POST', '/v1/grants', {
            resource: { route, id: scope.firstPost.id }, subject: { kind: 'account', id: historySubject },
            actions: ['post:read'], valid: `[${start},${end})`,
          }, 201);
        }
        const count = await db.admin.query(`SELECT count(*)::integer AS n FROM access.resource_grant
          WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='post:read'`, [route, scope.firstPost.id, historySubject]);
        expect(count.rows[0]!.n).toBe(scale);
        for (const relation of ['core.receipt', 'core.outbox', 'editorial.write_basis']) {
          const records = await db.admin.query(`SELECT count(*)::integer AS n FROM ${relation} WHERE partition_no=$1`, [home]);
          expect(records.rows[0]!.n).toBeGreaterThanOrEqual(scale);
        }
      }
    }
    return { native, db, call, checked, draft, revise, publications, snapshot, assertPublished, grow,
      close: async () => { try { await db.close(); } finally { await native.close(); } } };
  } catch (error) {
    try { await db.close(); } finally { await native.close(); }
    throw error;
  }
}
