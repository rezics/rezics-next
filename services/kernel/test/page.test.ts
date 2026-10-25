import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../src/database/pool.ts';
import type { AccountActor } from '../src/request/access.ts';
import { anchorRoute, partitionOf } from '../src/route/route.ts';
import { LIST_SUBJECTS, PAGE_SIZE, PageCursorError, pageSubjects } from '../src/semantic/page.ts';
import { CREATE_SUBJECT, createSubject } from '../src/semantic/subject.ts';
import { encodeCursor } from '../src/tokens/cursor.ts';
import type { KeyRing } from '../src/tokens/seal.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const routeKey = new Uint8Array(32).fill(9);
const actor: AccountActor = {
  kind: 'account',
  accountId: randomUUID(),
  clientId: 'web',
  scopes: [],
  requestedBy: null,
  authnEpoch: 1,
};
const allow = async () => true;

/** Idempotency keys whose new subjects all land in one partition. */
function keysInOnePartition(count: number): { partition: number; keys: string[] } {
  const routeOfKey = (key: string) => anchorRoute(routeKey, `${actor.accountId}\n${CREATE_SUBJECT}\n${key}`);
  const first = `page-${randomUUID()}`;
  const partition = partitionOf(routeOfKey(first));
  const keys = [first];
  for (let n = 0; keys.length < count; n++) {
    const key = `page-${n}-${randomUUID()}`;
    if (partitionOf(routeOfKey(key)) === partition) keys.push(key);
  }
  return { partition, keys };
}

async function createBooks(keys: string[]): Promise<{ id: string; title: string }[]> {
  const created = [];
  for (const [n, key] of keys.entries()) {
    const title = `Book ${n}`;
    const { subject } = await createSubject(pool, {
      actor,
      routeKey,
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { labels: { en: title, ja: `本 ${n}` }, descriptions: { en: 'a paged book' } },
      authorize: allow,
    });
    created.push({ id: subject.id, title });
  }
  return created;
}

const { partition, keys } = keysInOnePartition(5);
const books = await createBooks(keys);
const routeOfId = (id: string) => parseInt(id.slice(24, 28), 16);
const keyOrder = [...books].sort((a, b) => routeOfId(a.id) - routeOfId(b.id) || (a.id < b.id ? -1 : 1));
// Other tests may have created subjects in the same partition; compare only this file's books.
const ours = new Set(books.map((book) => book.id));
const own = (subjects: { id: string }[]) => subjects.map((subject) => subject.id).filter((id) => ours.has(id));

test('a partition pages in key order with labels, and the cursor resumes after the last subject', async () => {
  const seen: { id: string; labels: Record<string, string> }[] = [];
  let cursor: string | undefined;
  const sizes: number[] = [];
  do {
    const page = await pageSubjects(pool, ring, { partition, size: 2, ...(cursor === undefined ? {} : { cursor }) });
    expect(page).not.toBeNull();
    sizes.push(page!.subjects.length);
    seen.push(...page!.subjects);
    expect(page!.component).toMatchObject({ partition, epoch: expect.any(Number), position: expect.any(BigInt) });
    cursor = page!.next ?? undefined;
  } while (cursor !== undefined);
  expect(sizes.length).toBeGreaterThanOrEqual(3);
  expect(sizes.slice(0, -1).every((size) => size === 2)).toBe(true);
  expect(new Set(seen.map((subject) => subject.id)).size).toBe(seen.length);
  expect(own(seen)).toEqual(keyOrder.map((book) => book.id));
  const firstBook = seen.find((subject) => subject.id === keyOrder[0]!.id)!;
  expect(firstBook.labels).toEqual({ en: keyOrder[0]!.title, ja: `本 ${keyOrder[0]!.title.slice(5)}` });
  expect(seen.every((subject) => partitionOf(routeOfId(subject.id)) === partition)).toBe(true);
});

test('a page that holds the rest has no cursor, and the default size is twenty-five', async () => {
  expect(PAGE_SIZE).toEqual({ default: 25, max: 100 });
  const whole = await pageSubjects(pool, ring, { partition, size: PAGE_SIZE.max });
  expect(own(whole!.subjects)).toEqual(keyOrder.map((book) => book.id));
  expect(whole!.next).toBeNull();
  const defaults = await pageSubjects(pool, ring, { partition });
  expect(defaults!.subjects.length).toBe(Math.min(whole!.subjects.length, 25));
  const exact = await pageSubjects(pool, ring, { partition, size: whole!.subjects.length });
  expect(exact!.next).toBeNull();
  const short = await pageSubjects(pool, ring, { partition, size: whole!.subjects.length - 1 });
  expect(short!.next).toEqual(expect.any(String));
});

test('a cursor is bound to its partition and expires after fifteen minutes', async () => {
  const first = await pageSubjects(pool, ring, { partition, size: 1 });
  const cursor = first!.next!;
  const other = (partition + 1) % 4096;
  const refusal = (options: Parameters<typeof pageSubjects>[2]) =>
    pageSubjects(pool, ring, options).then(
      () => null,
      (error: unknown) => error,
    );
  expect(await refusal({ partition: other, cursor })).toMatchObject({ name: 'PageCursorError', reason: 'invalid' });
  expect(await refusal({ partition, cursor: `${cursor}x` })).toMatchObject({ reason: 'invalid' });
  const binding = { operation: LIST_SUBJECTS, parameters: { partition } };
  const old = encodeCursor(
    ring,
    binding,
    { epoch: 1, after: [partition * 16, keyOrder[0]!.id] },
    Date.now() - 16 * 60_000,
  );
  const expired = await refusal({ partition, cursor: old });
  expect(expired).toBeInstanceOf(PageCursorError);
  expect(expired).toMatchObject({ reason: 'expired' });
  const malformed = encodeCursor(ring, binding, { epoch: 1, after: ['not', 'keys', 3] });
  expect(await refusal({ partition, cursor: malformed })).toMatchObject({ reason: 'invalid' });
  const second = await pageSubjects(pool, ring, { partition, size: PAGE_SIZE.max, cursor });
  const last = first!.subjects[0]!.id;
  const after = (id: string) => routeOfId(id) > routeOfId(last) || (routeOfId(id) === routeOfId(last) && id > last);
  expect(own(second!.subjects)).toEqual(keyOrder.map((book) => book.id).filter(after));
});

test('a cursor from an earlier epoch is stale after a failover', async () => {
  const first = await pageSubjects(pool, ring, { partition, size: 1 });
  await admin.query('UPDATE core.partition SET epoch = epoch + 1 WHERE partition_no = $1', [partition]);
  try {
    const stale = await pageSubjects(pool, ring, { partition, size: 1, cursor: first!.next! }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(stale).toMatchObject({ name: 'PageCursorError', reason: 'stale' });
    const restarted = await pageSubjects(pool, ring, { partition, size: 1 });
    expect(restarted!.component.epoch).toBe(first!.component.epoch + 1);
  } finally {
    await admin.query('UPDATE core.partition SET epoch = epoch - 1 WHERE partition_no = $1', [partition]);
  }
});

test('the partition and the page size are bounded', async () => {
  for (const options of [{ partition: -1 }, { partition: 4096 }, { partition: 1.5 }])
    await expect(pageSubjects(pool, ring, options)).rejects.toThrow(RangeError);
  for (const size of [0, 101, 2.5])
    await expect(pageSubjects(pool, ring, { partition, size })).rejects.toThrow(RangeError);
});
