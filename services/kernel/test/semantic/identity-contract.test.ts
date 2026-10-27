import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId } from '../../src/route/route.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { accessCheck } from '../../src/request/access.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { linksCaughtUp } from '../../src/semantic/link-freshness.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  identityFixture,
  terminalReader,
  basisReader,
  groupReader,
  readOptions,
  readyBasis,
  readyWindow,
  deadline,
  resource,
  homeOf,
  continueGroup,
  reconstruct,
  binding,
  tokens,
  type IdentityFixture,
  type IdentityBasis,
  type GroupReader,
} from './identity-fixture.ts';
import { decodeListCursor, encodeListCursor } from '../../src/tokens/list-cursor.ts';

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

async function groupStep(read: GroupReader, root: string, basis: IdentityBasis, after: string | null, limit = 63) {
  const measured = await capture(db, () =>
    read(db.pool, { terminal: root, basis, after, limit, deadline: deadline() }),
  );
  const window = readyWindow(measured.value);
  expect(window.originals.length).toBeLessThanOrEqual(limit);
  expect(window.examined).toBeLessThanOrEqual(limit + 1);
  expect(new Set(window.originals).size).toBe(window.originals.length);
  expect([...window.originals].sort()).toEqual([...window.originals]);
  if (!window.exhausted) expect(window.after !== null && (after === null || window.after > after)).toBe(true);
  return window;
}

test('resumable alias groups find the last readable member beyond two hundred fifty six without unbounded scans', async () => {
  // Store real source occurrences first, including duplicates and overlap; root is intentionally not stored.
  const commands = createCollectionCommands({ pool: db.pool, access: f.access });
  const collection = (
    await commands.createCollection(f.editor, { title: 'Native alias source', visibility: 'private' }, randomUUID())
  ).value;
  const overlap = (
    await commands.createCollection(f.editor, { title: 'Native overlap source', visibility: 'private' }, randomUUID())
  ).value;
  const projection = linkProjection(db.pool);
  let storedCount = 0;
  async function stored(id: string) {
    for (const partition of [homeOf(id), homeOf(f.editor.accountId)]) {
      for (let batch = 0; batch < 100; batch++) {
        const result = await projection.run(partition);
        expect(
          result.status,
          JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? String(value) : value)),
        ).toBe('read');
        if (result.status !== 'read' || result.envelopes === 0) break;
      }
    }
    const head = (await db.pool.query('SELECT epoch, position FROM core.partition WHERE partition_no=$1', [homeOf(id)]))
      .rows[0]!;
    expect(
      await linksCaughtUp(
        db.pool,
        [{ partition: homeOf(id), epoch: head.epoch, position: BigInt(head.position) }],
        id,
        deadline(),
      ),
    ).toBe(true);
    // This baseline uses the existing full resolver; give its cold rendering a real request budget.
    await withRequestDeadline(deadline(), () =>
      commands.addMember(f.editor, collection.id, { subjectId: id }, randomUUID()),
    );
    if (storedCount++ === 0) {
      await withRequestDeadline(deadline(), () =>
        commands.addMember(f.editor, collection.id, { subjectId: id }, randomUUID()),
      );
      await withRequestDeadline(deadline(), () =>
        commands.addMember(f.editor, overlap.id, { subjectId: id }, randomUUID()),
      );
    }
  }
  const { root, originals, last } = await f.aliases(257, { stored });
  await f.baseline(last);
  const group = await groupReader();
  const terminal = await terminalReader();
  const basis = await readyBasis(await basisReader(), db.pool);
  let after: string | null = null;
  let examined = 0;
  const found: string[] = [];
  const raw: string[] = [];
  for (let step = 0; step < 20; step++) {
    const window = await groupStep(group, root, basis, after);
    examined += window.examined;
    raw.push(...window.originals);
    for (const original of window.originals) {
      // Real source authority plus actual stored occurrence, never a permission map or fake Hit.
      const check = await accessCheck(f.access, f.editor, 'collection:read', resource(collection.id), {
        pool: db.pool,
        deadline: deadline(),
      });
      const client = await db.pool.connect();
      let present = false;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const allowed = await check(client);
        const rows = await client.query(
          'SELECT 1 FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND subject_id=$3 LIMIT 1',
          [resource(collection.id).route, collection.id, original],
        );
        present = allowed && rows.rows.length > 0;
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      if (!present) continue;
      const identity = await terminal(db.pool, original, readOptions(f));
      if (identity?.state === 'ready') {
        expect(identity.id).toBe(root);
        found.push(original);
      }
    }
    if (window.exhausted) break;
    const token = await continueGroup(f.reader.accountId, root, basis, window.after);
    const restored = await reconstruct(token, f.reader.accountId, root, basis);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error('Native group continuation failed reconstruction');
    after = restored.after;
  }
  expect(raw).toEqual([...new Set([root, ...originals])].sort());
  expect(found).toEqual([last]);
  expect(examined).toBeGreaterThan(256);
  // Discovery is not a reusable permission proof. Revocation before final use must remove the positive.
  await f.hide(last);
  expect(await terminal(db.pool, last, readOptions(f))).toBeNull();
  await f.hide(last, 'restore');
}, 180_000);

test('concealed groups exhaust with advancing empty windows and current eligibility behind progress requires a fresh traversal', async () => {
  const { root, originals, last } = await f.aliases(258);
  await f.hide(last);
  await f.baseline(root);
  const group = await groupReader();
  const terminal = await terminalReader();
  const basis = await readyBasis(await basisReader(), db.pool);
  let after: string | null = null;
  let exhausted = false;
  for (let step = 0; step < 20; step++) {
    const window = await groupStep(group, root, basis, after, 31);
    for (const original of window.originals.filter((id) => id !== root))
      expect(await terminal(db.pool, original, readOptions(f))).toBeNull();
    if (step === 1) await f.hide(originals[0]!, 'restore');
    // That earlier key is never revisited by this current-keyset traversal.
    if (step > 1) expect(window.originals).not.toContain(originals[0]!);
    after = window.after;
    if (window.exhausted) {
      exhausted = true;
      break;
    }
  }
  expect(exhausted).toBe(true);
  expect(await terminal(db.pool, originals[0]!, readOptions(f))).toMatchObject({ state: 'ready', id: root });
  const fresh = await groupStep(group, root, basis, null, 31);
  expect(fresh.originals).toContain(originals[0]!);
}, 180_000);

test('alias continuation rejects invalid viewer route query group and structural bases and keeps shared token lifetimes', async () => {
  const later = await f.create(0x6df0);
  const { root } = await f.aliases(2, { conceal: false });
  const basis = await readyBasis(await basisReader(), db.pool);
  const group = await groupReader();
  const window = await groupStep(group, root, basis, null, 1);
  const now = new Date();
  const token = await continueGroup(f.reader.accountId, root, basis, window.after, now);
  expect(await reconstruct(token, f.other.accountId, root, basis, now)).toMatchObject({ ok: false });
  expect(await reconstruct(token, f.reader.accountId, newId(0x6e00), basis, now)).toMatchObject({ ok: false });
  expect(await reconstruct(`${token.slice(0, -2)}!!`, f.reader.accountId, root, basis, now)).toMatchObject({
    ok: false,
  });
  for (const changed of [
    { ...binding(f.reader.accountId, root), route: 'GET /v1/subject-target' },
    { ...binding(f.reader.accountId, root), query: { ...binding(f.reader.accountId, root).query, limit: 99 } },
  ])
    expect(await decodeListCursor(tokens, changed, token, now)).toMatchObject({ ok: false });
  expect(await reconstruct(token, f.reader.accountId, root, { digest: '0'.repeat(64) }, now)).toMatchObject({
    ok: false,
  });
  expect(await reconstruct(token, f.reader.accountId, root, basis, new Date(now.getTime() + 16 * 60_000))).toEqual({
    ok: false,
    reason: 'expired',
  });
  const anonymous = await continueGroup(null, root, basis, window.after, now);
  expect(await continueGroup(null, root, basis, window.after, new Date(now.getTime() + 86_400_000))).toBe(anonymous);
  expect(await reconstruct(anonymous, null, root, basis, new Date(now.getTime() + 86_400_000))).toMatchObject({
    ok: true,
  });
  expect(Buffer.from(token, 'base64url').toString()).not.toContain(root);
  const decoded = await decodeListCursor(tokens, binding(f.reader.accountId, root), token, now);
  expect(decoded.ok && decoded.after.length).toBe(8);
  await expect(
    encodeListCursor(tokens, binding(null, root), { epoch: 1, after: ['x'.repeat(257)] }, now),
  ).rejects.toThrow();

  await f.merge(root, later);
  expect(await group(db.pool, { terminal: root, basis, after: window.after, limit: 1, deadline: deadline() })).toEqual({
    state: 'basis_changed',
  });
  await f.finishMove(root, later);
  expect(await readyBasis(await basisReader(), db.pool)).not.toEqual(basis);
});

test('native repoint and verification reversal invalidate in-flight alias groups before any resumed disclosure', async () => {
  const next = await f.create(0x6900);
  const { root, originals } = await f.aliases(3, { conceal: false });
  const readBasis = await basisReader();
  const group = await groupReader();
  const terminal = await terminalReader();
  const basis = await readyBasis(readBasis, db.pool);
  const window = await groupStep(group, root, basis, null, 1);
  await f.merge(root, next);
  await f.finishMove(root, next);
  for (const id of originals) await f.finishMove(id, next);
  expect(await group(db.pool, { terminal: root, basis, after: window.after, limit: 1, deadline: deadline() })).toEqual({
    state: 'basis_changed',
  });
  expect(await terminal(db.pool, originals.at(-1)!, readOptions(f))).toMatchObject({ state: 'ready', id: next });

  const account = f.reader.accountId;
  await ensureAccountAgent(db.pool, { account, kind: 'person', name: null });
  const catalogue = await f.create(0x6900);
  const agent = accountAgentId(account);
  await verifyAccountAgent(db.pool, { account, catalogue, receipt: randomUUID() });
  await f.finishMove(agent, catalogue);
  const verified = await readyBasis(readBasis, db.pool);
  const partial = await groupStep(group, catalogue, verified, null, 1);
  await unverifyAccountAgent(db.pool, { account, receipt: randomUUID() });
  expect(
    await group(db.pool, {
      terminal: catalogue,
      basis: verified,
      after: partial.after,
      limit: 1,
      deadline: deadline(),
    }),
  ).toEqual({ state: 'basis_changed' });
  expect(await terminal(db.pool, agent, readOptions(f))).toMatchObject({ state: 'ready', id: agent });
  const fresh = await groupStep(group, catalogue, await readyBasis(readBasis, db.pool), null, 100);
  expect(fresh.originals).not.toContain(agent);
});

test('alias raw keys confer no subject or source authority and malformed allocations do not start a scan', async () => {
  const { root, last } = await f.aliases(2, { conceal: false });
  const group = await groupReader();
  const terminal = await terminalReader();
  const basis = await readyBasis(await basisReader(), db.pool);
  for (const limit of [0, 101, -1, 1.5]) {
    const failed = await capture(db, async () => {
      await expect(group(db.pool, { terminal: root, basis, after: null, limit, deadline: deadline() })).rejects.toThrow(
        RangeError,
      );
    });
    expect(failed.capture.statements).toHaveLength(0);
  }
  const window = await groupStep(group, root, basis, null, 100);
  expect(window.originals).toContain(last);
  const privateAccess = f.real.access({ actions: new Map([['subject:read', { anonymous: false }]]) });
  await f.real.grant(resource(root), 'reader', 'subject:read');
  expect(await terminal(db.pool, last, { ...readOptions(f), access: privateAccess })).toBeNull();
  await f.real.grant(resource(last), 'reader', 'subject:read');
  expect(await terminal(db.pool, last, { ...readOptions(f), access: privateAccess })).toMatchObject({
    state: 'ready',
    id: root,
  });
  await f.real.revoke(resource(root), 'reader', 'subject:read');
  expect(await terminal(db.pool, last, { ...readOptions(f), access: privateAccess })).toBeNull();

  const commands = createCollectionCommands({ pool: db.pool, access: f.access });
  const source = (
    await commands.createCollection(
      f.editor,
      { title: 'Current native source authority', visibility: 'private' },
      randomUUID(),
    )
  ).value;
  await f.real.grant(resource(source.id), 'reader', 'collection:read');
  async function sourceAllowed() {
    const check = await accessCheck(f.access, f.reader, 'collection:read', resource(source.id), {
      pool: db.pool,
      deadline: deadline(),
    });
    const client = await db.pool.connect();
    try {
      return await check(client);
    } finally {
      client.release();
    }
  }
  expect(await sourceAllowed()).toBe(true);
  await f.real.revoke(resource(source.id), 'reader', 'collection:read');
  expect(await sourceAllowed()).toBe(false);
  // A successful earlier group read cannot bypass either current denial.
  expect(window.originals).toContain(last);
  expect(await terminal(db.pool, last, { ...readOptions(f), access: privateAccess })).toBeNull();
});

test('an explicitly larger native survivor repoints inherited alias groups without a lexical-order assumption', async () => {
  const { root, originals } = await f.aliases(3, { conceal: false });
  // All baseline native operations above are legal and complete before resolving absent identity exports.
  const readBasis = await basisReader();
  const group = await groupReader();
  const terminal = await terminalReader();
  const old = await readyBasis(readBasis, db.pool);
  const larger = await f.create(0x6e00);
  expect(larger > root).toBe(true);
  await f.merge(root, larger);
  await f.finishMove(root, larger);
  for (const original of originals) await f.finishMove(original, larger);
  const current = await readyBasis(readBasis, db.pool);
  expect(current).not.toEqual(old);
  const window = await groupStep(group, larger, current, null, 100);
  expect(window.originals).toEqual([...originals, root, larger].sort());
  for (const original of originals)
    expect(await terminal(db.pool, original, readOptions(f))).toMatchObject({ state: 'ready', id: larger });
}, 180_000);
