import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { runCommand } from '../../src/command/command.ts';
import { mergeSubjectsInCommand } from '../../src/semantic/merges.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { accessCheck } from '../../src/request/access.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  identityFixture,
  basisReader,
  homeReader,
  readyBasis,
  deadline,
  release,
  resource,
  homeOf,
  type IdentityFixture,
  type HomeReader,
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

async function observedHome(read: HomeReader, id: string) {
  const client = await db.pool.connect();
  try {
    return await read(client, homeOf(id));
  } finally {
    client.release();
  }
}

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
