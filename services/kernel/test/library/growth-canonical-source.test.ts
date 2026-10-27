import { afterAll, beforeAll, expect, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import * as store from '../../src/library/canonical-source-store.ts';
import { openGrowthDatabase, checkGrowth, capture, type GrowthDatabase } from '../support/growth.ts';
import {
  canonicalFixture,
  allowance,
  ownerAllowance,
  charged,
  receipt,
  owner,
  repairSQL,
  type CanonicalFixture,
} from './canonical-source-fixture.ts';

let db: GrowthDatabase;
let f: CanonicalFixture;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await canonicalFixture(db);
});
afterAll(async () => {
  await db?.close();
});

test('canonical first and deep group seeks stay bounded at fixed quota with native last-alias positive success', async () => {
  let source: Awaited<ReturnType<CanonicalFixture['aliases']>>;
  let ready: Awaited<ReturnType<CanonicalFixture['build']>>;
  let deep: store.CanonicalGroupProgress;
  const report = await checkGrowth(db, {
    name: 'canonical first/deep alias group windows and positive final use',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale) {
      source = await f.aliases(scale); // Legal native writes; each Collection remains below 5000 occurrences.
      ready = await f.build(source.c.id);
      deep = { pendingSubjectId: source.terminal, after: null, ...ready };
      // Obtain the deep cursor by actually examining bounded windows; no made-up position/hash or permission cache.
      for (let examined = 0; examined + 100 < scale;) {
        const reserved = allowance(100);
        const step = await store.readCanonicalSourceGroup(db.pool, {
          ...f.call(source.c.id, reserved),
          basis: ready.basis,
          progress: deep,
        });
        receipt(step.work, reserved);
        if (step.state !== 'ready' || step.exhausted) throw new Error('Native group did not reach deep progress');
        expect(step.rows.length).toBeGreaterThan(0);
        examined += step.rows.length;
        deep = step.progress;
      }
    },
    async operation() {
      for (const progress of [{ pendingSubjectId: source.terminal, after: null, ...ready }, deep]) {
        const reserved = allowance(100);
        const window = await store.readCanonicalSourceGroup(db.pool, {
          ...f.call(source.c.id, reserved),
          basis: ready.basis,
          progress,
        });
        receipt(window.work, reserved);
        if (window.state !== 'ready') throw new Error('Native growth operation must succeed, never unknown/empty');
        expect(window.rows.length).toBeGreaterThan(0);
        expect(charged(window.work)).toBe(window.rows.length);
      }
      // Business success is mandatory in every measured run, using the ONE owner and real current Access.
      const native = await owner(f, source.c.id);
      const result = await native.api.containsSubject({
        ...native.context,
        allowance: ownerAllowance(100),
        source: native.source,
        subjectId: source.terminal,
        progress: deep,
        finalUse: true,
      });
      expect(result.result).toBe(true);
      expect(result.positiveEvidence).toBeDefined();
    },
  });
  expect(Object.values(report.shadow).every(({ outcome }) => outcome === 'compatible')).toBe(true);
}, 1_800_000);

test('canonical source seeks and raw repair checkpoints do not scan irrelevant native membership history', async () => {
  const c = await f.collection('public');
  const terminal = await f.subject();
  await f.add(c.id, terminal);
  const ready = await f.build(c.id);
  let history: Awaited<ReturnType<CanonicalFixture['collection']>>;
  let afterFact: { subject_id: string; member_id: string };
  const report = await checkGrowth(db, {
    name: 'canonical unrelated native history with fixed positive quota',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      history ??= await f.collection();
      for (let n = previous; n < scale; n++) await f.add(history.id, terminal, `Unrelated ${n}`);
      const raw = await f.facts(history.id);
      raw.sort((a, b) => a.member_id.localeCompare(b.member_id));
      afterFact = raw.at(-2)!; // Actual source key observed during setup, not invented readiness or identity.
    },
    async operation() {
      const reserved = allowance(1);
      const seek = await store.seekCanonicalSourceGroup(db.pool, {
        ...f.call(c.id, reserved),
        ...ready,
        afterSubjectId: null,
      });
      receipt(seek.work, reserved);
      expect(seek).toMatchObject({ state: 'ready', subjectId: terminal });
      const native = await owner(f, c.id);
      expect(
        (
          await native.api.containsSubject({
            ...native.context,
            source: native.source,
            subjectId: terminal,
            finalUse: true,
          })
        ).result,
      ).toBe(true);
      // Separately probe the exact native raw source access path beyond already examined history. This inspection
      // supplies no membership/basis proof: the positive above still requires the actual owner and Access.
      const raw = await db.pool.query(repairSQL, [
        routeOf(history.id),
        history.id,
        afterFact.subject_id,
        afterFact.member_id,
        1,
      ]);
      expect(raw.rows).toHaveLength(1);
    },
  });
  expect(Object.values(report.shadow).every(({ outcome }) => outcome === 'compatible')).toBe(true);
});

test('fixed-home identity metadata is measured independently of admitted source candidate work', async () => {
  const c = await f.collection('public');
  const id = await f.subject();
  await f.add(c.id, id);
  expect(await f.readable(id)).toBe(true);
  const reserved = allowance(0);
  const metadata = await capture(db, () => store.observeCanonicalSource(db.pool, f.call(c.id, reserved)));
  receipt(metadata.value.work, reserved);
  expect(metadata.value.state).toBe('admitted');
  expect(charged(metadata.value.work)).toBe(0);
  expect(metadata.value.work.identityMetadataRows).toBe(8192);
  expect(metadata.value.work.nativePoints).toBeGreaterThanOrEqual(8192);
  expect(metadata.capture.statements.length).toBeGreaterThan(0);
  // Metadata samples are not a successful empty candidate/growth proof, and are reported separately.
  console.log(
    JSON.stringify({
      name: 'canonical identity metadata',
      reservation: reserved.reservationId,
      work: metadata.value.work,
      statements: metadata.capture.statements.length,
    }),
  );
});
