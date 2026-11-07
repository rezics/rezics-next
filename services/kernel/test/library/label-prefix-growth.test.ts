import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import {
  capture,
  checkGrowth,
  catalogStatementBound,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Capture,
} from '../support/growth.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let db: GrowthDatabase, f: NativeProfileFixture;
let labels: ReturnType<typeof createPersonalLabelCommands>;
const clock = () => new Date('2026-01-01T00:00:00.000Z');
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool, clock });
  labels = createPersonalLabelCommands({ pool: db.pool, tokens: f.tokens, clock });
}, 120000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});

test('native prefix normalization binds effective queries and handles literal and scalar boundary ranges', async () => {
  const actor = (await f.identity(['library_entry:update', 'library_entry:list', 'library_entry:read'])).actor;
  const max = String.fromCodePoint(0x10ffff);
  const names = [
    'Bound\\literal',
    'Bound%literal',
    'Bound_literal',
    '\ud7ff' + max,
    '\ud7ff' + max + 'x',
    '\ue000',
    max,
    max + max,
  ];
  for (const name of names) await labels.createLabel(actor, { name }, entryKey());
  for (const q of ['Bound\\', 'Bound%', 'Bound_', '\ud7ff' + max, max]) {
    const first = await labels.listLabels(actor, { q, limit: 1 });
    expect(first.labels).toHaveLength(1);
    expect(first.labels[0]!.name.startsWith(q)).toBe(true);
    if (q === max || q.startsWith('\ud7ff')) {
      expect(first.next).toBeTruthy();
      const next = await labels.listLabels(actor, { q, limit: 1, cursor: first.next! });
      expect(next.labels).toHaveLength(1);
      expect(next.labels[0]!.name.startsWith(q)).toBe(true);
    }
  }
  const all = await labels.listLabels(actor, { limit: 1 });
  const whitespace = await labels.listLabels(actor, { q: ' \t ', limit: 1, cursor: all.next! });
  const unfiltered = await labels.listLabels(actor, { limit: 1, cursor: all.next! });
  expect(whitespace.labels).toEqual(unfiltered.labels);
  expect(Boolean(whitespace.next)).toBe(Boolean(unfiltered.next));
  const page = await labels.listLabels(actor, { q: ' Bound ', limit: 1 });
  await labels.listLabels(actor, { q: 'Bound', limit: 1, cursor: page.next! });
  for (const q of ['Other', 'bound'])
    await expect(labels.listLabels(actor, { q, limit: 1, cursor: page.next! })).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
  for (const q of ['\0', '\ud800', '字'.repeat(101), 7, null])
    await expect(labels.listLabels(actor, { q } as { q: string })).rejects.toMatchObject({ code: 'invalid_request' });
}, 120000);

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [...('Node Type' in value ? [value as Record<string, unknown>] : []), ...Object.values(value).flatMap(nodes)];
}
function assertPlans(raw: Capture) {
  const catalogue = catalogStatementBound(raw);
  expect(catalogue.catalogStatements).toBeLessThanOrEqual(catalogue.allowedStatements);
  const plans = raw.plans.flatMap(nodes);
  const labels = plans.filter((n) => n.Schema === 'library' && n['Relation Name'] === 'personal_label');
  expect(labels.length).toBeGreaterThan(0);
  for (const node of labels) {
    expect(node['Node Type']).not.toBe('Seq Scan');
    const examined =
      (Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)) * Number(node['Actual Loops']);
    expect(examined).toBeLessThanOrEqual(5); // P=4, plus the equal-name continuation point.
    if (node['Index Name'] === 'personal_label_live_name' && Number(node['Actual Loops']) > 0) {
      const condition = String(node['Index Cond']);
      expect(condition).toContain('normalized_name');
      expect(condition).toContain('>=');
      expect(condition).toContain('<');
    }
  }
  expect(labels.some((n) => n['Index Name'] === 'personal_label_live_name')).toBe(true);
  expect(raw.statements.some((s) => /\bLIKE\b/i.test(s))).toBe(false);
  for (const statement of raw.statements) {
    const offsets = statement.match(/\bOFFSET\s+\S+/gi) ?? [];
    for (const offset of offsets) expect(/^OFFSET\s+0$/i.test(offset)).toBe(true);
  }
}

test('native prefix generic prepared seeks charge fixed windows across 64 512 4096 matching nonmatching deleted names and same-partition owners', async () => {
  const actor = (await f.identity(['library_entry:update', 'library_entry:list'])).actor,
    route = routeOf(actor.accountId)!;
  const other = (await f.identity(['library_entry:update', 'library_entry:list'], partitionOf(route))).actor;
  async function template(owner: typeof actor, name: string, deleted: boolean) {
    const id = (await labels.createLabel(owner, { name }, entryKey())).value.label.id;
    if (deleted) await labels.deleteLabel(owner, id, 1, entryKey());
    return (
      await db.admin.query('SELECT * FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3', [
        routeOf(owner.accountId),
        owner.accountId,
        id,
      ])
    ).rows[0]!;
  }
  const live = await template(actor, 'Prefix growth live template', false);
  const hidden = await template(actor, 'Prefix growth deleted template', true);
  const neighbour = await template(other, 'Prefix growth neighbour template', false);
  const pool = db.openPool({ max: 1, options: '-c default_transaction_read_only=on' });
  const reader = createPersonalLabelCommands({ pool, tokens: f.tokens });
  async function operation() {
    const first = await reader.listLabels(actor, { q: 'Match ', limit: 4 });
    expect(first.labels).toHaveLength(4);
    expect(first.next).toBeTruthy();
    expect(first.labels.every((l) => l.name.startsWith('Match '))).toBe(true);
    const next = await reader.listLabels(actor, { q: 'Match ', limit: 4, cursor: first.next! });
    expect(next.labels).toHaveLength(4);
    expect(new Set([...first.labels, ...next.labels].map((l) => l.id)).size).toBe(8);
    expect((await reader.listLabels(actor, { q: 'Missing ', limit: 4 })).labels).toEqual([]);
  }
  const evidence: unknown[] = [];
  const report = await checkGrowth(db, {
    name: 'native prefix catalogue indexed windows',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      await seed(
        database,
        {
          name: 'prefix all population axes',
          hotPartition: partitionOf(route),
          hotShare: 1,
          rows(p) {
            const n = p.ordinal.toString().padStart(6, '0');
            return {
              'library.personal_label': [
                { ...live, label_id: newId(route), normalized_name: 'Match ' + n },
                { ...live, label_id: newId(route), normalized_name: 'Noise ' + n },
                { ...hidden, label_id: newId(route), normalized_name: 'Match deleted ' + n },
                { ...neighbour, label_id: newId(routeOf(other.accountId)!), normalized_name: 'Match ' + n },
              ],
            };
          },
        },
        { from: previous, to: scale },
      );
    },
    async warmup(_database, scale) {
      // Reuse a single native connection beyond PostgreSQL's custom-plan threshold, without planner settings.
      for (let n = 0; n < 6; n++) await operation();
      const measured = await capture(db, operation);
      assertPlans(measured.capture);
      evidence.push({ scale, capture: measured.capture });
    },
    operation,
  });
  console.info(JSON.stringify({ report, evidence }));
}, 1800000);
