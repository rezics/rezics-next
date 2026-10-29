import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeDocument, serializeDocument } from '@rezics/document';
import { createMentionNoticeEffect } from '../../src/content/mention-notices.ts';
import { createContentWorkAccess } from '../../src/content/register.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { standingFixture } from '../access/standing-fixture.ts';

const db = await openGrowthDatabase();
const fixture = await standingFixture();
fixture.reader.options.max = 1;
afterAll(async () => {
  await fixture.close();
  await db.close();
});

test('mention notice candidates stay bounded at 16, 64 and 256 mentions', async () => {
  await checkGrowth(db, {
    name: 'mention notices',
    scales: [16, 64, 256],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    grow: async () => {},
    operation: async (_database, scale) => {
      const route = 0x1234,
        thread = newId(route),
        post = newId(route),
        revision = newId(route),
        board = newId(route),
        subject = newId(route);
      const ids = Array.from({ length: scale }, () => newId(route));
      const doc = normalizeDocument({
        version: 'rezics-document-v1',
        profile: 'text',
        doc: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'mentions' },
              content: ids.map((accountId) => ({ type: 'mention', attrs: { accountId } })),
            },
          ],
        },
      });
      const body = Buffer.from(serializeDocument(doc));
      const digest = createHash('sha256').update(body).digest();
      const actor = fixture.actor;
      await fixture.reader.query('BEGIN');
      await fixture.reader.query(
        `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id) VALUES($1,$2,$3,'Growth','published',1,$2)`,
        [route, board, subject],
      );
      await fixture.reader.query(
        `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id) VALUES($1,$2,$3,$4,'Growth','published',1,$2,$5)`,
        [route, thread, actor, board, post],
      );
      await fixture.reader.query(
        `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id) VALUES($1,$2,$3,$4,$5,'published',1,$3)`,
        [route, thread, post, actor, revision],
      );
      await fixture.reader.query(
        `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id) VALUES($1,$2,$3,$4,$5,$6,'','MIT','{}',$7,'available',$3)`,
        [route, thread, post, revision, body, digest, board],
      );
      await fixture.reader.query('COMMIT');
      for (const id of ids)
        await fixture.reader.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2) ON CONFLICT DO NOTHING`,
          [routeOf(id), id],
        );
      for (const id of ids.slice(0, 10)) {
        await fixture.grant(id, 'thread:read', { route, id: thread });
        await fixture.grant(id, 'post:read', { route, id: post });
        await fixture.grant(id, 'board:read', { route, id: board });
      }
      const effect = createMentionNoticeEffect(
        _database.pool,
        createContentWorkAccess(() => new Date(), _database.pool),
      );
      await effect.run({
        specversion: '1.0',
        id: randomUUID(),
        source: `urn:rezics:log:${partitionOf(route)}.1`,
        type: 'com.rezics.content.post.created.v1',
        subject: post,
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        sequence: '0000000000000000001',
        data: {
          threadId: thread,
          itemId: post,
          revisionId: revision,
          actorId: actor,
          placeId: subject,
          kind: 'discussion',
          subjectIds: [],
          activityAt: new Date().toISOString(),
        },
      } as never);
      const count = (
        await _database.admin.query(
          `SELECT count(*)::int AS count FROM content.notice WHERE kind='mention' AND post_id=$1`,
          [post],
        )
      ).rows[0]?.count;
      expect(count).toBe(10);
      return count;
    },
  });
  const count = await fixture.reader.query(`SELECT count(*)::int AS count FROM content.notice WHERE kind='mention'`);
  expect(count.rows[0]?.count).toBeGreaterThan(0);
});
