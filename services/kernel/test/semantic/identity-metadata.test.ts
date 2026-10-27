import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId } from '../../src/route/route.ts';
import { accessCheck } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { linksCaughtUp } from '../../src/semantic/link-freshness.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  identityFixture,
  sealedIdentityReader,
  homeOf,
  resource,
  deadline,
  type IdentityFixture,
  type SealedIdentityReader,
} from './identity-fixture.ts';

let db: GrowthDatabase;
let f: IdentityFixture;
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  db = await openGrowthDatabase(url);
}, 30_000);
beforeEach(async () => {
  f = await identityFixture(db.pool, db.admin);
}, 30_000);
afterAll(async () => {
  if (db) await db.close();
});

async function point(read: SealedIdentityReader, original: string) {
  const client = await db.pool.connect();
  try {
    const checkout = spyOn(db.pool, 'connect');
    const authorize = spyOn(f.access, 'authorize');
    const prepare = spyOn(f.access, 'prepare');
    const authenticate = spyOn(f.access, 'authenticate');
    const priorReads = f.real.readChecks.length;
    try {
      const measured = await capture(db, async () => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const value = await read(client, original);
        await client.query('COMMIT');
        return value;
      });
      expect(checkout).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(authenticate).not.toHaveBeenCalled();
      expect(f.real.readChecks).toHaveLength(priorReads);
      const sql = measured.capture.statements.join('\n');
      expect(sql).not.toMatch(/\b(?:access|auth)\./i);
      expect(sql).not.toMatch(/\b(?:type|payload|labels)\b|SELECT\s+\*/i);
      expect(sql).not.toMatch(
        /semantic\.(?:fact|revision|label|outbound_link|inbound_link|merge_member|definition_release)\b/i,
      );
      expect(sql).not.toMatch(/WITH\s+RECURSIVE|enable_seqscan|checkpoint|\bjobs?\b/i);
      const cost = costOf(measured.capture);
      expect(cost.rows).toBeLessThanOrEqual(16);
      expect(cost.statements).toBeLessThanOrEqual(12);
      if (measured.value?.state === 'ready') {
        expect(Object.keys(measured.value).sort()).toEqual(['home', 'state', 'terminal']);
        expect(Object.keys(measured.value.home).sort()).toEqual([
          'epoch',
          'generation',
          'home',
          'partition',
          'pending',
        ]);
        expect(measured.value.home.partition).toBe(homeOf(original));
        expect(measured.value.home.epoch).toBeGreaterThan(0);
        expect(measured.value.home.home).toBeString();
        expect(typeof measured.value.home.generation).toBe('bigint');
        expect(typeof measured.value.home.pending).toBe('bigint');
      }
      return measured.value;
    } finally {
      checkout.mockRestore();
      authorize.mockRestore();
      prepare.mockRestore();
      authenticate.mockRestore();
    }
  } finally {
    client.release();
  }
}

test('sealed subject identity is actor-neutral bounded source-home metadata for live hidden and denied originals', async () => {
  const live = await f.create();
  const hidden = await f.create();
  const denied = await f.create();
  const root = await f.create(0x6e00);
  await f.merge(hidden, root);
  await f.finishMove(hidden, root);
  await f.merge(denied, root);
  await f.finishMove(denied, root);
  await f.baseline(live);
  await f.baseline(denied);
  await f.hide(hidden);
  const privateAccess = f.real.access({ actions: new Map([['subject:read', { anonymous: false }]]) });
  await f.real.grant(resource(root), 'reader', 'subject:read');
  async function allowed(id: string) {
    const check = await accessCheck(
      privateAccess,
      f.reader,
      'subject:read',
      {
        ...resource(id),
        eligibility: subjectReadEligibility(resource(id)),
      },
      { pool: db.pool, deadline: deadline() },
    );
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const value = await check(client);
      await client.query('COMMIT');
      return value;
    } finally {
      client.release();
    }
  }
  expect(await allowed(root)).toBe(true);
  expect(await allowed(denied)).toBe(false);
  const read = await sealedIdentityReader();
  expect(await point(read, live)).toMatchObject({ state: 'ready', terminal: live });
  expect(await point(read, hidden)).toMatchObject({ state: 'ready', terminal: root });
  const before = await point(read, denied);
  expect(before).toMatchObject({ state: 'ready', terminal: root });
  await f.real.grant(resource(denied), 'reader', 'subject:read');
  expect(await allowed(denied)).toBe(true);
  expect(await point(read, denied)).toEqual(before);
  await f.real.revoke(resource(denied), 'reader', 'subject:read');
  expect(await allowed(denied)).toBe(false);
  expect(await point(read, denied)).toEqual(before);
  await f.hide(root);
  expect(await point(read, denied)).toEqual(before);
  expect(await point(read, newId(0x6e10))).toBeNull();
  expect(await point(read, 'bad-id')).toBeNull();
});

test('sealed subject identity requires current registration and inherited larger-survivor repoint seals', async () => {
  const { root, originals } = await f.aliases(3, { conceal: false });
  const source = await f.create();
  await f.baseline(source);
  const read = await sealedIdentityReader();
  await f.merge(source, root);
  expect(await point(read, source)).toEqual({ state: 'not_ready' });
  await f.finishMove(source, root);
  const sourceSeal = await point(read, source);
  expect(sourceSeal).toMatchObject({ state: 'ready', terminal: root });
  expect(homeOf(source)).not.toBe(homeOf(root));
  const larger = await f.create(0x6e00);
  expect(larger > root).toBe(true);
  await f.merge(root, larger);
  expect(await point(read, root)).toEqual({ state: 'not_ready' });
  // A source-local seal alone never certifies current liveness of the target in another home.
  expect(await point(read, source)).toEqual(sourceSeal);
  await f.finishMove(root, larger);
  for (const original of [...originals, source]) await f.finishMove(original, larger);
  for (const original of [...originals, source, root])
    expect(await point(read, original)).toMatchObject({ state: 'ready', terminal: larger });
});

test('sealed subject identity uses the current native removal seal after verification reversal', async () => {
  // Existing trusted platform adapter boundary, never a fabricated end-user receipt or sealed metadata row.
  const account = f.other.accountId;
  await ensureAccountAgent(db.pool, { account, kind: 'person', name: null });
  const agent = accountAgentId(account);
  const root = await f.create(0x6df0);
  await verifyAccountAgent(db.pool, { account, catalogue: root, receipt: randomUUID() });
  await f.finishMove(agent, root);
  await f.baseline(agent);
  const read = await sealedIdentityReader();
  const merged = await point(read, agent);
  expect(merged).toMatchObject({ state: 'ready', terminal: root });
  await unverifyAccountAgent(db.pool, { account, receipt: randomUUID() });
  const restored = await point(read, agent);
  expect(restored).toMatchObject({ state: 'ready', terminal: agent, home: { pending: 0n } });
  if (restored?.state !== 'ready' || merged?.state !== 'ready') throw new Error('Expected native current seals');
  expect(restored.home.generation).toBeGreaterThan(merged.home.generation);
  await verifyAccountAgent(db.pool, { account, catalogue: root, receipt: randomUUID() });
  expect(await point(read, agent)).toEqual({ state: 'not_ready' });
  await f.finishMove(agent, root);
  expect(await point(read, agent)).toMatchObject({ state: 'ready', terminal: root });
});

test('sealed subject identity discovers all two hundred fifty seven stored originals before visibility filtering', async () => {
  const commands = createCollectionCommands({ pool: db.pool, access: f.access });
  const collection = (
    await commands.createCollection(
      f.editor,
      { title: 'Stored original repair metadata', visibility: 'private' },
      randomUUID(),
    )
  ).value;
  const projection = linkProjection(db.pool);
  const { root, originals, last } = await f.aliases(257, {
    async stored(id) {
      for (const partition of [homeOf(id), homeOf(f.editor.accountId)]) {
        for (let batch = 0; batch < 100; batch++) {
          const result = await projection.run(partition);
          expect(result.status).toBe('read');
          if (result.status !== 'read' || result.envelopes === 0) break;
        }
      }
      const head = (
        await db.pool.query('SELECT epoch, position FROM core.partition WHERE partition_no=$1', [homeOf(id)])
      ).rows[0]!;
      expect(
        await linksCaughtUp(
          db.pool,
          [
            {
              partition: homeOf(id),
              epoch: head.epoch,
              position: BigInt(head.position),
            },
          ],
          id,
          deadline(),
        ),
      ).toBe(true);
      await withRequestDeadline(deadline(), () =>
        commands.addMember(f.editor, collection.id, { subjectId: id }, randomUUID()),
      );
    },
  });
  await f.baseline(last);
  const stored = await db.pool.query(
    'SELECT subject_id FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY subject_id',
    [resource(collection.id).route, collection.id],
  );
  expect(stored.rows.map((row: { subject_id: string }) => row.subject_id)).toEqual(originals);
  const read = await sealedIdentityReader();
  for (const original of originals)
    expect(await point(read, original)).toMatchObject({ state: 'ready', terminal: root });
  // Trusted discovery leaves every stored original intact, including the concealed prefix.
  expect(
    (
      await db.pool.query(
        'SELECT count(*)::int AS n FROM library.collection_member WHERE route=$1 AND collection_id=$2',
        [resource(collection.id).route, collection.id],
      )
    ).rows[0].n,
  ).toBe(257);
}, 600_000);
