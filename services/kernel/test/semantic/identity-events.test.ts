import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { lookupEventType } from '../../src/events/catalogue.ts';
import { runCommand } from '../../src/command/command.ts';
import { routeOf } from '../../src/route/route.ts';
import { mergeSubjectsInCommand } from '../../src/semantic/merges.ts';
import { ensureAccountAgent, verifyAccountAgent, unverifyAccountAgent } from '../../src/semantic/account-agents.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { identityFixture, homeOf, deadline, release, type IdentityFixture } from './identity-fixture.ts';

let db: GrowthDatabase;
let f: IdentityFixture;
const identityChanged = 'com.rezics.subject.identity.changed.v1';
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

// Resolve after real native setup. A missing event export must be the intended red, never a static import error.
async function eventContract() {
  const events: Record<string, unknown> = await import('../../src/semantic/events.ts');
  expect(
    events.SUBJECT_IDENTITY_CHANGED,
    'Missing additive semantic/events.SUBJECT_IDENTITY_CHANGED; native baseline completed',
  ).toBe(identityChanged);
  const validator = lookupEventType(identityChanged);
  expect(
    validator,
    'Identity event must be registered by its producer before the first command seals the catalogue',
  ).toBeDefined();
  if (!validator) throw new Error('Missing registered identity event');
  for (const generation of ['0', '1', '9007199254740993', '18446744073709551615'])
    expect(validator.Check({ generation })).toBe(true);
  for (const generation of ['', '01', '-1', '+1', '1.0', '1e3', ' 1', 1, null])
    expect(validator.Check({ generation })).toBe(false);
  expect(validator.Check({})).toBe(false);
  expect(validator.Check({ generation: '1', revision: 1 })).toBe(false);
  expect(validator.Check({ generation: '1', target: 'private' })).toBe(false);
}

type Envelope = {
  partition_no: number;
  epoch: number;
  position: string;
  event_seq: number;
  event_count: number;
  type: string;
  subject: string | null;
  data: { generation: string };
};
async function identityEvents(original: string): Promise<Envelope[]> {
  return (
    await db.pool.query(
      `SELECT partition_no, epoch, position::text, event_seq, event_count, type, subject, data
     FROM core.outbox WHERE partition_no=$1 AND type=$2 AND subject=$3 ORDER BY position, event_seq`,
      [homeOf(original), identityChanged, original],
    )
  ).rows;
}
async function obligation(original: string) {
  const result = await db.pool.query(
    `SELECT version::text, target FROM semantic.identity_obligation
     WHERE partition_no=$1 AND route=$2 AND subject_id=$3`,
    [homeOf(original), routeOf(original), original],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0] as { version: string; target: string | null };
}
async function currentEvent(original: string, target: string | null) {
  const events = await identityEvents(original);
  const event = events.at(-1);
  expect(event).toBeDefined();
  if (!event) throw new Error('Actual native mapping change emitted no identity event');
  const current = await obligation(original);
  expect(current.target).toBe(target);
  expect(event.data).toEqual({ generation: current.version });
  expect(event.data.generation).toMatch(/^(0|[1-9][0-9]*)$/);
  expect(event.subject).toBe(original);
  expect(event.partition_no).toBe(homeOf(original));
  expect(event.epoch).toBeGreaterThan(0);
  expect(BigInt(event.position)).toBeGreaterThan(0n);
  const siblings = (
    await db.pool.query(
      'SELECT epoch, event_seq, event_count, type, subject, data FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
      [event.partition_no, event.position],
    )
  ).rows;
  expect(siblings).toHaveLength(event.event_count);
  expect(siblings.map((row) => row.event_seq)).toEqual(siblings.map((_, index) => index));
  expect(siblings.every((row) => row.epoch === event.epoch && row.event_count === event.event_count)).toBe(true);
  return { event, siblings };
}
async function revision(original: string) {
  return (
    await db.pool.query(
      'SELECT revision, recorded_transaction_id FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision DESC LIMIT 1',
      [routeOf(original), original],
    )
  ).rows[0] as { revision: number; recorded_transaction_id: string };
}
async function sameRevisionCommand(original: string, event: Envelope) {
  const latest = await revision(original);
  const basis = (
    await db.pool.query(
      'SELECT epoch, position::text FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2',
      [homeOf(original), latest.recorded_transaction_id],
    )
  ).rows;
  expect(basis).toEqual([{ epoch: event.epoch, position: event.position }]);
}

test('native merge identity event is registered closed original-anchored and tied to the actual structural obligation', async () => {
  const source = await f.create();
  const root = await f.create(0x6e00);
  await f.baseline(source);
  await eventContract();
  const key = randomUUID();
  const merged = await f.merge(source, root, key);
  const { event, siblings } = await currentEvent(source, root);
  expect(await identityEvents(source)).toHaveLength(1);
  expect(event.position).toBe(merged.component.position.toString());
  expect(event.epoch).toBe(merged.component.epoch);
  expect(siblings).toContainEqual(
    expect.objectContaining({
      type: 'com.rezics.subject.merged.v1',
      subject: source,
      data: { id: source, survivor: root },
    }),
  );
  await sameRevisionCommand(source, event);
  // Authorized receipt replay keeps the original committed fence and adds no identity event.
  expect((await f.merge(source, root, key)).component).toEqual(merged.component);
  expect(await identityEvents(source)).toEqual([event]);
  await f.finishMove(source, root);
  await f.finishMove(source, root);
  expect(await identityEvents(source)).toEqual([event]);
  expect(await identityEvents(root)).toEqual([]);
});

test('native redirect rollback commits neither mapping obligation generation nor identity event', async () => {
  const source = await f.create();
  const root = await f.create(0x6e00);
  await f.baseline(source);
  await eventContract();
  const before = (
    await db.pool.query('SELECT generation::text, pending::text FROM semantic.identity_home WHERE partition_no=$1', [
      homeOf(source),
    ])
  ).rows;
  const failure = new Error('Rollback structural identity event');
  await expect(
    runCommand(
      db.pool,
      {
        partition: homeOf(source),
        deadline: deadline(),
        authorization: await f.authorization('subject:merge'),
        basis: { actorAccountId: f.editor.accountId, clientId: f.editor.clientId, requestedBy: f.editor.requestedBy },
      },
      async (tx, { transactionId }) => {
        const merged = await mergeSubjectsInCommand(tx, transactionId, { survivor: root, redirected: source, release });
        const current = (
          await tx.query(
            'SELECT version::text FROM semantic.identity_obligation WHERE partition_no=$1 AND route=$2 AND subject_id=$3',
            [homeOf(source), routeOf(source), source],
          )
        ).rows[0];
        expect(merged.events.filter((event) => event.type === identityChanged)).toEqual([
          { type: identityChanged, subject: source, data: { generation: current.version } },
        ]);
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  expect(await identityEvents(source)).toEqual([]);
  expect(
    (
      await db.pool.query('SELECT target FROM semantic.redirect WHERE route=$1 AND subject_id=$2', [
        routeOf(source),
        source,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.pool.query(
        'SELECT version FROM semantic.identity_obligation WHERE partition_no=$1 AND route=$2 AND subject_id=$3',
        [homeOf(source), routeOf(source), source],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await db.pool.query('SELECT generation::text, pending::text FROM semantic.identity_home WHERE partition_no=$1', [
        homeOf(source),
      ])
    ).rows,
  ).toEqual(before);
});

test('inherited larger-survivor repoint emits in the changed original home without a fake subject revision', async () => {
  const source = await f.create(0x6e10);
  const root = await f.create(0x6d00);
  await f.merge(source, root);
  await f.finishMove(source, root);
  await f.baseline(source);
  await eventContract();
  const before = await revision(source);
  const first = await currentEvent(source, root);
  const larger = await f.create(0x6f00);
  expect(larger > root).toBe(true);
  expect(homeOf(source)).not.toBe(homeOf(larger));
  await f.merge(root, larger);
  await f.finishMove(root, larger);
  await f.finishMove(source, larger);
  const { event, siblings } = await currentEvent(source, larger);
  expect(await identityEvents(source)).toHaveLength(2);
  expect(BigInt(event.data.generation)).toBeGreaterThan(BigInt(first.event.data.generation));
  expect(await revision(source)).toEqual(before);
  expect(siblings.some((row) => row.type === 'com.rezics.semantic.links.projected.v1')).toBe(true);
  expect(
    siblings.some((row) =>
      ['com.rezics.subject.created.v1', 'com.rezics.subject.revised.v1', 'com.rezics.subject.merged.v1'].includes(
        row.type,
      ),
    ),
  ).toBe(false);
  const redirect = (
    await db.pool.query(
      `SELECT r.target, r.recorded_transaction_id, x.xmin::text AS event_xmin, r.xmin::text AS redirect_xmin
     FROM semantic.redirect r JOIN core.outbox x ON x.partition_no=$3 AND x.position=$4 AND x.event_seq=$5
     WHERE r.route=$1 AND r.subject_id=$2 ORDER BY r.sequence DESC LIMIT 1`,
      [routeOf(source), source, homeOf(source), event.position, event.event_seq],
    )
  ).rows[0];
  expect(redirect.target).toBe(larger);
  // Native system tuple provenance proves the repoint and outbox were committed by the same transaction.
  expect(redirect.redirect_xmin).toBe(redirect.event_xmin);
  const all = await identityEvents(source);
  await f.finishMove(source, larger);
  expect(await identityEvents(source)).toEqual(all);
});

test('trusted native verification and removal emit actual identity changes while receipt repeats do not', async () => {
  // Existing platform adapter boundary; no fabricated end-user verification or metadata rows.
  const account = f.other.accountId;
  await ensureAccountAgent(db.pool, { account, kind: 'person', name: null });
  const agent = accountAgentId(account);
  const root = await f.create(0x6df0);
  await f.baseline(agent);
  await eventContract();
  const receipt = randomUUID();
  const verified = await verifyAccountAgent(db.pool, { account, catalogue: root, receipt });
  const first = await currentEvent(agent, root);
  expect(first.event.position).toBe(verified.component.position.toString());
  expect(first.siblings.some((row) => row.type === 'com.rezics.subject.merged.v1')).toBe(true);
  await verifyAccountAgent(db.pool, { account, catalogue: root, receipt });
  expect(await identityEvents(agent)).toEqual([first.event]);
  await f.finishMove(agent, root);
  const revoke = randomUUID();
  const restored = await unverifyAccountAgent(db.pool, { account, receipt: revoke });
  const second = await currentEvent(agent, null);
  expect(await identityEvents(agent)).toHaveLength(2);
  expect(second.event.position).toBe(restored.component.position.toString());
  expect(second.event.epoch).toBe(restored.component.epoch);
  expect(BigInt(second.event.data.generation)).toBeGreaterThan(BigInt(first.event.data.generation));
  expect(second.siblings).toContainEqual(
    expect.objectContaining({
      type: 'com.rezics.subject.revised.v1',
      subject: agent,
      data: { id: agent, revision: restored.revision, kind: 'merge' },
    }),
  );
  const all = await identityEvents(agent);
  await unverifyAccountAgent(db.pool, { account, receipt: revoke });
  expect(await identityEvents(agent)).toEqual(all);
});
