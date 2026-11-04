import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  DEFAULT_INBOX_SELECTION,
  inboxCandidateScanLimit,
  INBOX_CANDIDATE_FACTOR,
  INBOX_CANDIDATE_SCAN_CEILING,
  InvalidInboxCursorError,
  listNoticeInbox,
  markNoticesSeen,
  type InboxDependencies,
} from '../../src/content/notice-inbox.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { reactionFixture } from './reactions.test.ts';
import { observeSql } from './support/sql-observer.ts';
import { readNoticeActors } from '../../src/content/notice-actor-context.ts';

let fixture: Awaited<ReturnType<typeof reactionFixture>>;
let inbox: InboxDependencies;
const originalReceiptKeys = process.env.KERNEL_RECEIPT_KEYS;
beforeAll(async () => {
  process.env.KERNEL_RECEIPT_KEYS = [...testReceiptKeys().keys]
    .map(([version, key]) => `${version}:${Buffer.from(key).toString('base64url')}`)
    .join(',');
  fixture = await reactionFixture();
  const verified = await fixture.verified();
  if (verified.kind !== 'account') throw new Error('expected an account viewer');
  await fixture.db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,'account:read','(,)',$2) ON CONFLICT DO NOTHING`,
    [routeOf(fixture.accountId), fixture.accountId],
  );
  inbox = {
    pool: fixture.db.pool,
    routeKey: new Uint8Array(32).fill(71),
    access: fixture.access,
    actor: { ...verified, authnEpoch: Math.max(verified.authnEpoch, 1) },
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) },
    deadline: Date.now() + 180_000,
  };
}, 120_000);
afterAll(async () => {
  await fixture?.close();
  if (originalReceiptKeys === undefined) delete process.env.KERNEL_RECEIPT_KEYS;
  else process.env.KERNEL_RECEIPT_KEYS = originalReceiptKeys;
});

function list(input: { limit: number; cursor?: string; selection?: 'all' | 'unread' }) {
  return listNoticeInbox(inbox, fixture.accountId, input);
}

async function seed(count: number) {
  await fixture.db.admin.query('TRUNCATE TABLE content.notice_ack, content.notice, content.notice_seen');
  const recipient = fixture.accountId;
  const r = routeOf(recipient)!;
  const ids = Array.from({ length: count }, (_, i) => newId(r));
  await fixture.db.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
     SELECT $1,$2,x,'moderation_decision',x,'2026-10-27T00:00:00Z'::timestamptz + i * interval '1 second'
     FROM unnest($3::uuid[]) WITH ORDINALITY AS v(x,i)`,
    [r, recipient, ids],
  );
  return ids;
}

test('candidate scan limits are static page-size bounds', () => {
  expect(DEFAULT_INBOX_SELECTION).toBe('all');
  expect(INBOX_CANDIDATE_FACTOR).toBe(4);
  expect(INBOX_CANDIDATE_SCAN_CEILING).toBe(200);
  expect(inboxCandidateScanLimit(1)).toBe(4);
  expect(inboxCandidateScanLimit(20)).toBe(80);
  expect(inboxCandidateScanLimit(50)).toBe(200);
});

test('All and Unread bind selection into the cursor, admit displayed through, and seek unread without walking read pages', async () => {
  const ids = await seed(5);
  const newest = ids[4]!;
  const unreadOlder = ids[3]!;
  const base = `/v1/accounts/${fixture.accountId}/notifications`;
  await markNoticesSeen(fixture.db.pool, fixture.accountId, ids[2]!);

  const all = await list({ limit: 10, selection: 'all' });
  expect(all.selection).toBe('all');
  expect(all.viewer).toEqual({ accountId: fixture.accountId });
  expect(all.items.map((item) => item.id)).toEqual([...ids].reverse());
  expect(all.actions.markSeen).toEqual({
    method: 'POST',
    path: `${base}:markSeen`,
    through: newest,
  });

  const unread = await list({ limit: 10, selection: 'unread' });
  expect(unread.selection).toBe('unread');
  expect(unread.items.map((item) => [item.id, item.unread])).toEqual([
    [newest, true],
    [unreadOlder, true],
  ]);
  expect(unread.next).toBeNull();
  expect(unread.actions.markSeen?.through).toBe(newest);

  const continuing = await list({ limit: 1, selection: 'unread' });
  expect(continuing.items.map((item) => item.id)).toEqual([newest]);
  expect(continuing.next).toEqual(expect.any(String));
  expect(continuing.actions.markSeen).toBeNull();
  const sameRange = await list({ limit: 1, selection: 'unread', cursor: continuing.next! });
  expect(sameRange.items.map((item) => item.id)).toEqual([unreadOlder]);
  expect(sameRange.selection).toBe('unread');

  const allFirst = await list({ limit: 1, selection: 'all' });
  await expect(list({ limit: 1, selection: 'unread', cursor: allFirst.next! })).rejects.toBeInstanceOf(
    InvalidInboxCursorError,
  );
  await expect(list({ limit: 1, selection: 'all', cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
    InvalidInboxCursorError,
  );
});

test('list candidate LIMIT is min(4×page size, 200) at three page sizes for All and Unread', async () => {
  await seed(3);
  const observed: number[] = [];
  for (const selection of ['all', 'unread'] as const) {
    for (const limit of [1, 20, 50]) {
      const trace = observeSql(fixture.db.pool);
      try {
        const page = await list({ limit, selection });
        expect(page.selection).toBe(selection);
        const listed = trace.records.find(
          (record) => record.statement.includes('FROM content.notice AS n') && record.statement.includes('DESC LIMIT'),
        )!;
        expect(listed.parameters.at(-1)).toBe(inboxCandidateScanLimit(limit));
        expect(listed.statement.split('s.seen_notice_id IS NULL').length - 1).toBe(selection === 'unread' ? 2 : 1);
        observed.push(listed.parameters.at(-1) as number);
      } finally {
        await trace.close();
      }
    }
  }
  expect(observed).toEqual([4, 80, 200, 4, 80, 200]);
});

test('notice actor composition admits Media variants independently and retires changed Account observations', async () => {
  const id = fixture.accountId;
  const r = routeOf(id)!;
  const media = newId(r);
  await fixture.db.admin.query(
    `INSERT INTO content.media
      (route,media_id,container_id,uploader_id,reservation_request_id,purpose,media_type,
       byte_count,actual_byte_count,sha256,state,key,transaction_id,width,height,thumbhash,average_color)
     VALUES ($1,$2,$3,$3,$2::text,'avatar','image/png',256,256,repeat('a',64),'available',
             'unused-original-key',$2,64,64,decode('010203','hex'),'#123456')`,
    [r, media, id],
  );
  await fixture.db.admin.query(
    `INSERT INTO content.media_variant(route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
     VALUES ($1,$2,'webp',64,64,'image/webp',100,repeat('b',64),'unused-variant-key',$2)`,
    [r, media],
  );
  const original = (await fixture.db.admin.query(
    'SELECT display_name FROM access.account WHERE route=$1 AND account_id=$2', [r, id],
  )).rows[0];
  const reset = () => fixture.db.admin.query(
    `UPDATE access.account SET state='active',authn_fenced=false,display_name=$3,avatar=$4
     WHERE route=$1 AND account_id=$2`, [r, id, original.display_name, media],
  );
  await reset();
  const trace = observeSql(fixture.db.pool);
  const read = () => readNoticeActors(fixture.db.pool, [id, id], Date.now() + 30_000);
  try {
    expect((await read()).get(id)).toMatchObject({
      state: 'available', avatarUrl: null,
      avatar: { media, width: 64, height: 64, variants: [{ format: 'webp', width: 64 }] },
    });
    const observations = trace.records.filter((row) => row.statement.includes('AS "nativeState"'));
    expect(observations).toHaveLength(2);
    const statement = observations[0]!.statement;
    expect(trace.records.filter((row) => row.statement.includes('variants_json'))).toHaveLength(1);
    for (const assignment of ["avatar=NULL", "display_name='Replacement name'", 'authn_fenced=true', "state='pending'", "state='deleted'"]) {
      await reset();
      const barrier = trace.hold({ statement, occurrence: 2 }, 'before');
      const reading = read();
      try {
        await barrier.entered;
        await fixture.db.admin.query(`UPDATE access.account SET ${assignment} WHERE route=$1 AND account_id=$2`, [r, id]);
      } finally { barrier.release(); }
      expect((await reading).get(id)).toBeUndefined();
    }
    await reset();
    trace.armFault({ match: { statement, occurrence: 2 }, boundary: 'before', error: new Error('Account observation unavailable') });
    await expect(read()).rejects.toThrow('Account observation unavailable');
    await fixture.db.admin.query('UPDATE content.media SET taken_down=true WHERE route=$1 AND media_id=$2', [r, media]);
    expect((await read()).get(id)).toMatchObject({ state: 'available', avatar: null, avatarUrl: null });
  } finally {
    await trace.close();
    await reset();
    await fixture.db.admin.query('UPDATE access.account SET avatar=NULL WHERE route=$1 AND account_id=$2', [r, id]);
  }
});
