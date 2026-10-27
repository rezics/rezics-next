import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { AccessUnavailableError } from '../../src/access/index.ts';
import { runCommand, authoritativeTimeValue, type AuthoritativeTime } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { mergeSubjectsInCommand } from '../../src/semantic/merges.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { accessCheck } from '../../src/request/access.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  identityFixture,
  terminalReader,
  basisReader,
  homeReader,
  groupReader,
  readOptions,
  readyBasis,
  readyWindow,
  deadline,
  release,
  resource,
  homeOf,
  continueGroup,
  reconstruct,
  binding,
  tokens,
  type IdentityFixture,
  type IdentityBasis,
  type GroupReader,
  type HomeReader,
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

function lightweight(statements: readonly string[]) {
  const sql = statements.join('\n');
  expect(sql).not.toMatch(
    /semantic\.(?:fact|revision|outbound_link|inbound_link|adoption|candidate|definition_release|partition_subjects)\b/i,
  );
  expect(sql).not.toMatch(/(?:checkpoint|waitFor|summary|read-subject\.sql)/i);
  expect(sql).not.toMatch(/WITH\s+RECURSIVE|enable_seqscan/i);
}

async function observedHome(read: HomeReader, id: string) {
  const client = await db.pool.connect();
  try {
    return await read(client, homeOf(id));
  } finally {
    client.release();
  }
}

// Frozen reference and metadata helpers are deliberately neither imported nor implemented here.
test('terminal identity is a lightweight current authorized read with explicit maintenance readiness', async () => {
  const source = await f.create(0x6e10);
  const root = await f.create(0x6e00);
  await f.baseline(source);
  const read = await terminalReader();
  const live = await capture(db, () => read(db.pool, source, readOptions(f)));
  expect(live.value).toMatchObject({ state: 'ready', id: source });
  lightweight(live.capture.statements);
  expect(Object.keys(live.value ?? {}).sort()).toEqual(['components', 'id', 'state']);

  await f.merge(source, root);
  // Redirect insertion predates alias registration: neither a fresh checkpoint nor an idle worker proves readiness.
  const pending = await capture(db, () => read(db.pool, source, readOptions(f)));
  expect(pending.value).toEqual({ state: 'not_ready' });
  lightweight(pending.capture.statements);
  await f.finishMove(source, root);
  const redirected = await capture(db, () => read(db.pool, source, readOptions(f)));
  expect(redirected.value).toMatchObject({ state: 'ready', id: root });
  lightweight(redirected.capture.statements);

  await f.hide(root);
  expect(await read(db.pool, source, readOptions(f))).toBeNull();
  await f.hide(root, 'restore');
  await f.hide(source);
  expect(await read(db.pool, source, readOptions(f))).toBeNull();
  expect(await read(db.pool, newId(0x6e10), readOptions(f))).toBeNull();
  expect(await read(db.pool, 'bad-id', readOptions(f))).toBeNull();
  // Even an explicit native grant cannot disclose a hidden original.
  await f.real.grant(resource(source), 'reader', 'subject:read');
  expect(await read(db.pool, source, readOptions(f))).toBeNull();
  await f.hide(source, 'restore');
  expect(await read(db.pool, source, readOptions(f))).toMatchObject({ state: 'ready', id: root });
});

test('terminal anchors use released same-client RR Access and native preparation time', async () => {
  const source = await f.create(0x6e30);
  const root = await f.create(0x6e00);
  await f.merge(source, root);
  await f.finishMove(source, root);
  await f.baseline(source);
  const read = await terminalReader();
  const checks: { id: string; client: unknown; time: AuthoritativeTime | undefined }[] = [];
  const access = deriveAccess(f.access, {
    async authorize(client, actor, action, anchor, evidence, time) {
      if (action === 'subject:read') {
        const isolation = await client.query('SHOW transaction_isolation');
        expect(isolation.rows[0].transaction_isolation).toBe('repeatable read');
        const mode = await client.query('SHOW transaction_read_only');
        expect(mode.rows[0].transaction_read_only).toBe('on');
        checks.push({ id: anchor.id, client, time });
      }
      return f.access.authorize(client, actor, action, anchor, evidence, time);
    },
    async prepare(actor, action, anchor, context) {
      // A pool of size one can prepare the next anchor only after releasing the previous RR checkout.
      const value = await f.access.prepare!(actor, action, anchor, context);
      return value;
    },
  });
  const single = db.openPool({ max: 1 });
  try {
    const authorization = await f.authorization('subject:merge');
    let nativeT: AuthoritativeTime | undefined;
    await runCommand(
      db.pool,
      {
        partition: homeOf(source),
        deadline: deadline(),
        basis: { actorAccountId: f.editor.accountId, clientId: f.editor.clientId, requestedBy: f.editor.requestedBy },
        authorization: {
          ...authorization,
          async prepare(attempt) {
            nativeT = attempt.time;
            expect(Number.isFinite(Date.parse(authoritativeTimeValue(attempt.time)))).toBe(true);
            const observed = await capture(db, () =>
              read(single, source, {
                ...readOptions(f),
                access,
                nativeT: attempt.time,
              }),
            );
            expect(observed.value).toMatchObject({ state: 'ready', id: root });
            lightweight(observed.capture.statements);
            return authorization.prepare!(attempt);
          },
        },
      },
      async () => ({ value: null, events: [{ type: 'com.rezics.semantic.identity-observed.v1', data: {} }] }),
    );
    expect(checks.map((check) => check.id)).toEqual([source, root]);
    expect(checks.every((check) => check.time === nativeT)).toBe(true);
  } finally {
    await single.end();
  }

  // An installed native authenticated-only catalogue proves original and terminal grants independently.
  const privateAccess = f.real.access({ actions: new Map([['subject:read', { anonymous: false }]]) });
  const options = { ...readOptions(f), access: privateAccess };
  await f.real.grant(resource(source), 'reader', 'subject:read');
  expect(await read(db.pool, source, options)).toBeNull();
  await f.real.grant(resource(root), 'reader', 'subject:read');
  expect(await read(db.pool, source, options)).toMatchObject({ state: 'ready', id: root });
  await f.real.revoke(resource(source), 'reader', 'subject:read');
  expect(await read(db.pool, source, options)).toBeNull();
  await expect(read(db.pool, root, { ...readOptions(f), deadline: Date.now() - 1 })).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
});

test('structural identity generation changes atomically on redirect unmerge and repoint but not unrelated positions', async () => {
  const next = await f.create(0x6df0);
  const source = await f.create(0x6e10);
  const root = await f.create(0x6e00);
  await f.baseline(source);
  const home = await homeReader();
  const basis = await basisReader();
  const before = await observedHome(home, source);
  const stable = await readyBasis(basis, db.pool);
  const check = await accessCheck(f.access, f.editor, 'subject:create', resource(root), {
    pool: db.pool,
    deadline: deadline(),
  });
  await f.real.grant(resource(root), 'editor', 'subject:create');
  await updateSubjectIdentity(db.pool, {
    subject: root,
    labels: { en: 'Unrelated editorial change' },
    release,
    authorize: check,
  });
  expect(await readyBasis(basis, db.pool)).toEqual(stable);
  const failure = new Error('Rollback native redirect and generation');
  const authorization = await f.authorization('subject:merge');
  await expect(
    runCommand(
      db.pool,
      {
        partition: homeOf(source),
        deadline: deadline(),
        authorization,
        basis: { actorAccountId: f.editor.accountId, clientId: f.editor.clientId, requestedBy: f.editor.requestedBy },
      },
      async (tx, { transactionId }) => {
        await mergeSubjectsInCommand(tx, transactionId, { survivor: root, redirected: source, release });
        expect((await home(tx as PoolClient, homeOf(source))).generation).toBe(before.generation + 1n);
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  expect(await observedHome(home, source)).toEqual(before);
  expect(await readyBasis(basis, db.pool)).toEqual(stable);

  const replayKey = randomUUID();
  await f.merge(source, root, replayKey);
  const inserted = await observedHome(home, source);
  expect(inserted.generation).toBe(before.generation + 1n);
  expect(inserted.pending).toBeGreaterThan(0n);
  expect(await basis(db.pool, { deadline: deadline() })).toEqual({ state: 'not_ready' });
  await f.merge(source, root, replayKey);
  expect((await observedHome(home, source)).generation).toBe(inserted.generation);
  await f.finishMove(source, root);
  const mergedBasis = await readyBasis(basis, db.pool);
  expect(mergedBasis).not.toEqual(stable);

  await f.merge(root, next);
  await f.finishMove(root, next);
  // Native member maintenance repoints the old original in its own home.
  await f.finishMove(source, next);
  expect((await observedHome(home, source)).generation).toBe(inserted.generation + 1n);
  expect(await readyBasis(basis, db.pool)).not.toEqual(mergedBasis);

  // Trusted native platform verification adapter; this is not an end-user verification receipt.
  const account = f.other.accountId;
  await ensureAccountAgent(db.pool, { account, kind: 'person', name: null });
  const catalogue = await f.create(0x6df0);
  const agent = accountAgentId(account);
  const agentHome = await observedHome(home, agent);
  await verifyAccountAgent(db.pool, { account, catalogue, receipt: randomUUID() });
  expect((await observedHome(home, agent)).generation).toBe(agentHome.generation + 1n);
  await f.finishMove(agent, catalogue);
  const verified = await readyBasis(basis, db.pool);
  await unverifyAccountAgent(db.pool, { account, receipt: randomUUID() });
  expect((await observedHome(home, agent)).generation).toBe(agentHome.generation + 2n);
  expect(await readyBasis(basis, db.pool)).not.toEqual(verified);
});

test('concurrent native redirects cannot lose structural increments and epoch or home changes invalidate a basis', async () => {
  const first = await f.create(0x6e70);
  const second = await f.create(0x6e70);
  const root = await f.create(0x6e00);
  await f.baseline(first);
  const home = await homeReader();
  const basis = await basisReader();
  const before = await observedHome(home, first);
  await Promise.all([f.merge(first, root), f.merge(second, root)]);
  expect((await observedHome(home, first)).generation).toBe(before.generation + 2n);
  await f.finishMove(first, root);
  await f.finishMove(second, root);
  const old = await readyBasis(basis, db.pool);
  // Negative invalidation probe of existing core metadata, never a positive subject/permission fixture.
  await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [homeOf(first)]);
  expect(await readyBasis(basis, db.pool)).not.toEqual(old);
  const current = await observedHome(home, first);
  expect(current.epoch).toBe(before.epoch + 1);
  expect(current.home).toBeString();
  const epochBasis = await readyBasis(basis, db.pool);
  await db.admin.query('UPDATE core.partition SET node=$2 WHERE partition_no=$1', [
    homeOf(first),
    `${current.home}-replacement`,
  ]);
  expect(await readyBasis(basis, db.pool)).not.toEqual(epochBasis);
  // Restore routing metadata after the negative incarnation probe.
  await db.admin.query('UPDATE core.partition SET node=$2 WHERE partition_no=$1', [homeOf(first), current.home]);
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
        if (result.status !== 'read' || result.envelopes === 0) break;
      }
    }
    await commands.addMember(f.editor, collection.id, { subjectId: id }, randomUUID());
    if (storedCount++ === 0) {
      await commands.addMember(f.editor, collection.id, { subjectId: id }, randomUUID());
      await commands.addMember(f.editor, overlap.id, { subjectId: id }, randomUUID());
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
