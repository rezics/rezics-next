import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accessCheck } from '../../src/request/access.ts';
import { updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { checkGrowth, capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  identityFixture,
  terminalReader,
  basisReader,
  groupReader,
  readyBasis,
  readyWindow,
  readOptions,
  resource,
  deadline,
  release,
  type IdentityFixture,
} from './identity-fixture.ts';

let db: GrowthDatabase;
let f: IdentityFixture;
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  db = await openGrowthDatabase(url);
  f = await identityFixture(db.pool, db.admin);
}, 30_000);
afterAll(async () => {
  if (db) await db.close();
});
const scales = [64, 512, 4096] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

// Every positive result is native identity truth plus actual Access, never successful null/not_ready.
test('identity alias steps keep fixed candidate and point budgets as the native group grows', async () => {
  const root = await f.create(0x6c00);
  await f.baseline(root);
  const group = await groupReader();
  const terminal = await terminalReader();
  const readBasis = await basisReader();
  const originals: string[] = [];
  const report = await checkGrowth(db, {
    name: 'identity alias steps keep fixed candidate and point budgets as the native group grows',
    scales,
    bounds,
    warmups: 1,
    repetitions: 3,
    async grow(_database, scale, previous) {
      if (originals.length) await f.hide(originals.at(-1)!);
      const added: string[] = [];
      for (let index = previous; index < scale; index++) added.push(await f.create(0x6c10));
      added.sort();
      for (const id of added) {
        await f.merge(id, root);
        await f.finishMove(id, root);
      }
      originals.push(...added);
      originals.sort();
      for (const id of added) if (id !== originals.at(-1)) await f.hide(id);
      await f.baseline(originals.at(-1)!);
    },
    async operation() {
      // Both fixed-home metadata sweeps and Access preparation remain inside the shared capture.
      const basis = await readyBasis(readBasis, db.pool);
      const window = readyWindow(
        await group(db.pool, {
          terminal: root,
          basis,
          after: originals.at(-33)!,
          limit: 32,
          deadline: deadline(),
        }),
      );
      expect(window.examined).toBeLessThanOrEqual(33);
      expect(window.points).toBeLessThanOrEqual(134);
      expect(window.originals).toEqual(originals.slice(-32));
      const readable: string[] = [];
      for (const original of window.originals) {
        const identity = await terminal(db.pool, original, readOptions(f));
        if (identity?.state === 'ready') {
          expect(identity.id).toBe(root);
          readable.push(original);
        } else expect(identity).toBeNull();
      }
      expect(readable).toEqual([originals.at(-1)!]);
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    // Mandatory home metadata is measured alongside, not subtracted as a control/background allowance.
    expect(sample.cost.relations['semantic.identity_home']?.rows).toBeGreaterThanOrEqual(4096);
    expect(sample.cost.relations['semantic.merge_member']?.sequentialScans ?? 0).toBe(0);
    expect(Object.keys(sample.relationSizes).some((name) => name.startsWith('index:'))).toBe(true);
  }
}, 600_000);

test('terminal identity and fixed-home digest stay bounded as irrelevant editorial history grows', async () => {
  const original = await f.create(0x6b10);
  const root = await f.create(0x6b00);
  await f.merge(original, root);
  await f.finishMove(original, root);
  await f.baseline(original);
  const terminal = await terminalReader();
  const basis = await basisReader();
  const stable = await readyBasis(basis, db.pool);
  let historySubject = '';
  const report = await checkGrowth(db, {
    name: 'terminal identity and fixed-home digest stay bounded as irrelevant editorial history grows',
    scales,
    bounds,
    warmups: 1,
    repetitions: 3,
    async grow(_database, scale, previous) {
      for (let ordinal = previous; ordinal < scale; ordinal++) {
        // Respect native per-slot history limits: a new unrelated subject every sixteen edits.
        if (ordinal % 16 === 0) {
          historySubject = await f.create(0x6b10);
          await f.real.grant(resource(historySubject), 'editor', 'subject:create');
        }
        const authorize = await accessCheck(f.access, f.editor, 'subject:create', resource(historySubject), {
          pool: db.pool,
          deadline: deadline(),
        });
        await updateSubjectIdentity(db.pool, {
          subject: historySubject,
          labels: { en: `Editorial history ${ordinal}` },
          release,
          authorize,
        });
      }
    },
    async operation() {
      expect(await readyBasis(basis, db.pool)).toEqual(stable);
      const result = await terminal(db.pool, original, readOptions(f));
      expect(result).toMatchObject({ state: 'ready', id: root });
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.cost.relations['semantic.fact']).toBeUndefined();
    expect(sample.cost.relations['semantic.revision']).toBeUndefined();
    expect(sample.cost.relations['semantic.identity_home']?.rows).toBeGreaterThanOrEqual(4096);
  }
}, 600_000);

test('terminal identity and alias windows stay bounded as unrelated native population and redirect history grow', async () => {
  const { root, originals, last } = await f.aliases(33);
  const group = await groupReader();
  const terminal = await terminalReader();
  const basis = await basisReader();
  const report = await checkGrowth(db, {
    name: 'terminal identity and alias windows stay bounded as unrelated native population and redirect history grow',
    scales,
    bounds,
    warmups: 1,
    repetitions: 3,
    async grow(_database, scale, previous) {
      for (let ordinal = previous; ordinal < scale; ordinal++) {
        const irrelevant = await f.create(0x6a10);
        const survivor = await f.create(0x6a00);
        await f.merge(irrelevant, survivor);
        await f.finishMove(irrelevant, survivor);
      }
    },
    async operation() {
      const current = await readyBasis(basis, db.pool);
      const window = readyWindow(
        await group(db.pool, {
          terminal: root,
          basis: current,
          after: originals[0]!,
          limit: 32,
          deadline: deadline(),
        }),
      );
      expect(window.originals).toEqual(originals.slice(1));
      expect(window.examined).toBeLessThanOrEqual(33);
      expect(await terminal(db.pool, last, readOptions(f))).toMatchObject({ state: 'ready', id: root });
    },
  });
  expect(report.samples).toHaveLength(3);
  // Keep the raw native plans/statements available to the assertion; no custom capture or slack.
  const measured = await capture(db, () => terminal(db.pool, last, readOptions(f)));
  expect(measured.value).toMatchObject({ state: 'ready', id: root });
  const cost = costOf(measured.capture);
  expect(cost.rows).toBeGreaterThan(0);
  expect(cost.blocks).toBeGreaterThan(0);
  expect(measured.capture.plans.length).toBeGreaterThan(0);
  expect(measured.capture.statements.join('\n')).not.toMatch(
    /WITH\s+RECURSIVE|enable_seqscan|semantic\.(?:fact|revision|inbound_link|outbound_link)\b/i,
  );
}, 600_000);
