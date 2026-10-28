import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mintReadTime } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { routeOf } from '../../src/route/route.ts';
import {
  readNativeCollectionMetadata as observe,
  authorizeNativeCollectionMetadata as authorize,
  readNativeCollectionRawPage as page,
  probeNativeCollectionOriginal as probe,
  type NativeCollectionMetadata,
  type CanonicalRangeKey,
} from '../../src/library/collection-source-native.ts';
import type { WorkReceipt } from '../../src/library/collection-source.ts';
import factsQuery from '../../src/library/collection-source-native-facts.sql';
import { capture, checkGrowth, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let db: GrowthDatabase, native: NativeProfileFixture;
const allowance = () => ({
  reservationId: entryKey(),
  remaining: {
    candidateKeys: 100,
    identityMetadataRows: 0,
    nativeRows: 1000000,
    nativePoints: 10000,
    witnessKeys: 10000,
    statements: 1000,
    bytes: 16 * 1024 * 1024,
    emptySeeks: 100,
  },
});
const options = () => ({ deadline: Date.now() + 30000, allowance: allowance() });
beforeAll(async () => {
  db = await openGrowthDatabase();
  native = await createProfileEntryFixture({ pool: db.pool });
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await native?.close();
  await db?.close();
});
async function measured<T extends { work: WorkReceipt }>(operation: () => Promise<T>) {
  const measured = await capture(db, operation, { includeBackends: true });
  // Actual node rows include loops and removals; this is separate from the charged plan bound.
  expect(costOf(measured.capture).rows).toBeLessThanOrEqual(measured.value.work.used.nativeRows);
  expect(measured.capture.statements.length).toBe(measured.value.work.used.statements);
  expect(costOf(measured.capture).catalogStatements).toBe(0);
  expect(costOf(measured.capture).backgroundStatements ?? 0).toBe(0);
  for (const sql of measured.capture.statements) expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE)\b/i);
  return measured.value;
}
test('actual curated first/deep source seeks and exact original probes retain bounded duplicate evidence as history grows', async () => {
  const owner = await native.identity(['subject:read', 'collection:create', 'collection:read', 'collection:update']);
  const created = await native.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Raw growth',
    visibility: 'private',
  });
  expect(created.status).toBe(201);
  const id = (await created.json()).collection.id as string,
    subject = await native.createSubject('game');
  let metadata!: NativeCollectionMetadata,
    after: CanonicalRangeKey | null = null;
  await checkGrowth(db, {
    name: 'native raw curated source first/deep and exact original',
    scales: [16, 64, 256],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      for (let n = previous; n < scale; n++)
        expect(
          (
            await native.send(owner.bearer, 'POST', `/v1/collections/${id}/members`, {
              subjectId: subject,
              note: 'Private ' + n,
            })
          ).status,
        ).toBe(201);
      metadata = (await observe(db.pool, { route: routeOf(id)!, collectionId: id }, options())).metadata!;
      expect(metadata).toBeDefined();
      after = null;
      for (let n = 0; n < scale - 8; n += 8) {
        const result = await page(db.pool, metadata, { ...options(), driver: 'member', after, limit: 8 });
        expect(result.rows).toHaveLength(8);
        after = result.after;
      }
    },
    async operation() {
      for (const start of [null, after]) {
        const result = await page(db.pool, metadata, { ...options(), driver: 'member', after: start, limit: 8 });
        expect(result.rows).toHaveLength(8);
        expect(result.exhausted).toBe(false);
        expect(result.work.used.candidateKeys).toBe(8);
        expect(new Set(result.rows.map((r) => r.key.factId)).size).toBe(8);
        for (const row of result.rows) expect(Object.keys(row)).toEqual(['key']);
      }
      const result = await probe(db.pool, metadata, { ...options(), originalId: subject });
      expect(result.result).toBe('present');
      expect(result.key?.storedSubjectId).toBe(subject);
      expect(result.witness?.sourceGeneration).toBe(metadata.sourceGeneration);
    },
  });
  await measured(() => page(db.pool, metadata, { ...options(), driver: 'member', after, limit: 8 }));
  const positive = await measured(() => probe(db.pool, metadata, { ...options(), originalId: subject }));
  const missing = await measured(() => probe(db.pool, metadata, { ...options(), originalId: native.unknownSubject() }));
  expect(positive.result).toBe('present');
  expect(missing.result).toBe('absent');
  const bounded = await probe(db.pool, metadata, {
    ...options(),
    originalId: subject,
    allowance: { ...allowance(), remaining: { ...allowance().remaining, nativeRows: 0 } },
  });
  expect(bounded.result).toBe('not_proven');
  expect(bounded.work.used.nativeRows).toBe(0);
}, 1800000);
test('native admission settles partial work and closes its read transaction before rejecting an unaffordable point', async () => {
  const owner = await native.identity(['collection:create', 'collection:read']);
  const created = await native.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Admission',
    visibility: 'private',
  });
  expect(created.status).toBe(201);
  const id = (await created.json()).collection.id as string;
  const result = await capture(db, async () => {
    try {
      await observe(
        db.pool,
        { route: routeOf(id)!, collectionId: id },
        {
          ...options(),
          allowance: { ...allowance(), remaining: { ...allowance().remaining, nativePoints: 1 } },
        },
      );
      throw new Error('Unaffordable native query dispatched');
    } catch (error) {
      expect(error).toHaveProperty('code', 'dependency_unavailable');
      return (error as Error & { work: WorkReceipt }).work;
    }
  });
  expect(result.value.used.nativePoints).toBe(1);
  expect(result.value.used.nativeRows).toBe(0);
  expect(result.value.used.statements).toBe(2);
  expect(result.capture.statements).toHaveLength(2);
  expect(result.capture.statements[0]).toMatch(/^BEGIN/);
  expect(result.capture.statements[1]).toBe('ROLLBACK');
});
test('actual raw fact SQL limits the selected native driver before union and leaves unselected relations unread', async () => {
  for (const group of ['personal_library', 'reading_progress'])
    expect((await native.send('steward', 'POST', `/v1/platform/exposure/${group}:open`)).status).toBe(200);
  const owner = await native.identity([
    'subject:read',
    'library_entry:update',
    'copy:create',
    'progress_session:create',
  ]);
  const subject = await native.createSubject('game');
  expect((await native.send(owner.bearer, 'PUT', `/v1/libraryEntries/${subject}`, { state: 'planned' })).status).toBe(
    201,
  );
  const expected: Record<string, string[]> = { entry: [subject], copy: [], session: [], label: [] };
  for (let n = 0; n < 16; n++) {
    const copy = await native.send(owner.bearer, 'POST', '/v1/copies', {
      subjectId: subject,
      status: 'owned',
    });
    expect(copy.status).toBe(201);
    expected.copy!.push((await copy.json()).copy.id);
    const session = await native.send(owner.bearer, 'POST', '/v1/progressSessions', {
      subjectId: subject,
      mode: 'scalar_amount',
      unit: 'minute',
    });
    expect(session.status).toBe(201);
    expected.session!.push((await session.json()).progressSession.id);
  }
  const tables = { entry: 'entry', copy: 'copy', session: 'progress_session', label: 'label_assignment' };
  for (const [driver, table] of Object.entries(tables)) {
    const values = {
      route: routeOf(owner.actor.accountId)!,
      account_id: owner.actor.accountId,
      driver,
      after_subject: null,
      after_fact: null,
      limit: 8,
    };
    const run = () =>
      withConnection(db.pool, (client) =>
        client.query<{ storedSubjectId: string; factId: string }>(
          factsQuery.sql,
          factsQuery.params.map((name) => values[name as keyof typeof values]),
        ),
      );
    const result = await capture(db, run, { includeBackends: true });
    expect(result.value.rows.map((row) => row.factId)).toEqual(expected[driver]!.sort().slice(0, 8));
    expect(costOf(result.capture).rows).toBeLessThanOrEqual(72);
    for (const other of Object.values(tables).filter((name) => name !== table))
      expect(costOf(result.capture).relations[`library.${other}`]?.rows ?? 0).toBe(0);
    const walk = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (typeof node['Relation Name'] === 'string' && node['Relation Name'] !== table) {
        expect(node['Actual Loops']).toBe(0);
        expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
      }
      for (const child of Object.values(node))
        if (Array.isArray(child)) child.forEach(walk);
        else if (child && typeof child === 'object') walk(child);
    };
    result.capture.plans.forEach(walk);
  }
}, 120000);
test('native current source authorization preserves anonymous visibility, private fences and gate closure without observation grants', async () => {
  const owner = await native.identity(['subject:read', 'collection:create', 'collection:read', 'collection:update']);
  const created = await native.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Current source',
    visibility: 'public',
  });
  expect(created.status).toBe(201);
  const id = (await created.json()).collection.id as string;
  const metadata = (await measured(() => observe(db.pool, { route: routeOf(id)!, collectionId: id }, options())))
    .metadata!;
  const at = await withConnection(db.pool, (c) => mintReadTime(c, () => new Date()));
  const anonymous = { kind: 'anonymous' } as const;
  expect(
    (await measured(() => authorize(db.pool, metadata, { ...options(), access: native.access, actor: anonymous, at })))
      .authorized,
  ).toBe(true);
  expect(
    (await native.send(owner.bearer, 'PATCH', `/v1/collections/${id}`, { revision: 1, visibility: 'private' })).status,
  ).toBe(200);
  expect(
    (await authorize(db.pool, metadata, { ...options(), access: native.access, actor: anonymous, at })).authorized,
  ).toBe(false);
  const fresh = await native.access.authenticate(owner.bearer, { pool: db.pool, deadline: Date.now() + 30000 });
  expect(
    (await measured(() => authorize(db.pool, metadata, { ...options(), access: native.access, actor: fresh, at })))
      .authorized,
  ).toBe(true);
  await native.revokeIdentity(owner.actor.accountId);
  expect(
    (await authorize(db.pool, metadata, { ...options(), access: native.access, actor: fresh, at })).authorized,
  ).toBe(false);
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/collections:close')).status).toBe(200);
  const closedAt = await withConnection(db.pool, (c) => mintReadTime(c, () => new Date()));
  expect(
    (await authorize(db.pool, metadata, { ...options(), access: native.access, actor: anonymous, at: closedAt }))
      .authorized,
  ).toBe(false);
}, 120000);
