import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type Capture,
  type Cost,
  type GrowthDatabase,
} from '../support/growth.ts';
import { assertUnforcedIndexes, logGrowthSeeding } from './planner-fixtures.ts';
import {
  PAGE_SIZE,
  LOOKAHEAD,
  SCALES,
  disclosedLabel,
  forwardPageGrowthFixture,
  type ForwardPage,
  type ForwardPageGrowthFixture,
  type PublicCursors,
} from './forward-page-growth-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');

const SELECTED = PAGE_SIZE;
const SELECTED_SLOT_FACTS = 1;
const TARGET_LABELS = 1;
const PAGE_PARTITIONS = 1;
// Mounted GET /v1/subjects/:id/relations: one outbound keyset of s+1, one counter,
// selected compact slots, one summary fill per page partition, Access per related id,
// then a released-snapshot reread of those same slots and native fence points.
const probeOperands = {
  holderVisibility: 2,
  partitionHead: 1,
  freshnessCheckpoint: 1,
  outboundSeeks: SELECTED + LOOKAHEAD,
  outboundCounter: 1,
  selectedSlots: SELECTED * SELECTED_SLOT_FACTS,
  rereadSlots: SELECTED * SELECTED_SLOT_FACTS,
  summarySubjects: SELECTED,
  summaryLabels: SELECTED * TARGET_LABELS,
  summaryImageHeads: SELECTED,
  summaryOriginalLanguageSlots: SELECTED,
  summaryRepresentativeRanges: SELECTED,
  accessHolder: 1,
  accessTargets: SELECTED,
  pagePartitions: PAGE_PARTITIONS,
};
const indexProbes = Object.values(probeOperands).reduce((total, value) => total + value, 0);
const bounds = { rows: 'constant' as const, statements: 'constant' as const, blocks: 'logarithmic' as const };
const covering = {
  'semantic.subject': 'subject_pkey',
  'semantic.fact': ['fact_terms', 'fact_label', 'fact_pkey'],
  'semantic.outbound_link': 'outbound_link_present',
  'semantic.outbound_link_count': 'outbound_link_count_pkey',
} as const;

let db: GrowthDatabase;
let fixture: ForwardPageGrowthFixture;

beforeAll(async () => {
  db = await openGrowthDatabase(url);
  fixture = await forwardPageGrowthFixture(db);
}, 60_000);

afterAll(async () => {
  if (db) await db.close();
});

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const record = value as Record<string, unknown>;
  return [...(typeof record['Node Type'] === 'string' ? [record] : []), ...Object.values(record).flatMap(nodes)];
}

function examined(node: Record<string, unknown>): number {
  return (
    (Number(node['Actual Rows'] ?? 0) +
      Number(node['Rows Removed by Filter'] ?? 0) +
      Number(node['Rows Removed by Index Recheck'] ?? 0)) *
    Number(node['Actual Loops'] ?? 0)
  );
}

function outboundExamined(raw: Capture): number {
  return nodes(raw.plans)
    .filter((node) => node['Relation Name'] === 'outbound_link' && Number(node['Actual Loops'] ?? 0) > 0)
    .reduce((total, node) => total + examined(node), 0);
}

function report(name: string, scale: number, raw: Capture, page: ForwardPage): void {
  const cost = costOf(raw);
  console.info(
    'Forward page disclosure capture',
    JSON.stringify({
      name,
      scale,
      delivered: page.relations.length,
      next: page.next !== null,
      statements: cost.statements,
      controlStatements: cost.controlStatements,
      rows: cost.rows,
      blocks: cost.blocks,
      sharedHit: cost.sharedHit,
      sharedRead: cost.sharedRead,
      outboundExamined: outboundExamined(raw),
      relations: cost.relations,
      backgroundStatements: cost.backgroundStatements,
      backgroundRows: cost.backgroundRows,
      backgroundBlocks: cost.backgroundBlocks,
      limitations: cost.limitations,
    }),
  );
}

function assertDisclosedPage(page: ForwardPage, scale: number, size = PAGE_SIZE): void {
  expect(page.relations).toHaveLength(size);
  expect(page).not.toHaveProperty('count');
  expect(page.next).toEqual(expect.any(String));
  expect(page.freshness?.consistency).toBe('eventual');
  for (const row of page.relations) {
    expect(row.target).toBeString();
    expect(row.label).toMatch(/^Author \d{4}$/);
    expect(row.target).not.toBe(fixture.hidden.id);
    expect(row.target).not.toBe(fixture.denied.id);
  }
}

function assertContinuedPage(page: ForwardPage, scale: number): void {
  expect(page.relations.length).toBeGreaterThan(0);
  expect(page.relations.length).toBeLessThanOrEqual(PAGE_SIZE);
  expect(page).not.toHaveProperty('count');
  expect(page.freshness?.consistency).toBe('eventual');
  for (const row of page.relations) {
    expect(row.target).toBeString();
    expect(typeof row.label).toBe('string');
    expect(row.target).not.toBe(fixture.hidden.id);
    expect(row.target).not.toBe(fixture.denied.id);
  }
}

function assertEmptyPage(page: ForwardPage, scale: number): void {
  expect(page.relations, `exhausted page at ${scale} returned rows`).toEqual([]);
  expect(page).not.toHaveProperty('count');
  expect(page.next).toBeNull();
}

function assertNoFillScan(raw: Capture): void {
  const sql = raw.statements.join('\n');
  expect(sql).not.toMatch(/enable_seqscan|set_config\s*\(/i);
  for (const node of nodes(raw.plans)) {
    if (node['Relation Name'] === 'outbound_link' && Number(node['Actual Loops'] ?? 0) > 0)
      expect(node['Node Type']).not.toBe('Seq Scan');
  }
  expect(outboundExamined(raw)).toBeLessThanOrEqual(PAGE_SIZE + LOOKAHEAD);
}

function assertReread(raw: Capture): void {
  const begins = raw.statements.filter((text) => /^BEGIN/i.test(text)).length;
  expect(begins).toBeGreaterThan(1);
}

function assertAuthority(cost: Cost, raw: Capture): void {
  expect(cost.rows).toBeGreaterThan(0);
  expect(Object.keys(cost.relations).some((name) => name.startsWith('access.') || name === 'semantic.subject')).toBe(
    true,
  );
  expect(raw.statements.some((text) => /resource_grant|resource_denial|visibility/i.test(text))).toBe(true);
}

async function captureCase(
  name: string,
  scale: number,
  operation: () => Promise<ForwardPage>,
  required: typeof covering | Record<string, never> = covering,
): Promise<{ page: ForwardPage; capture: Capture; cost: Cost }> {
  const measured = await capture(db, operation, { includeBackends: true });
  report(name, scale, measured.capture, measured.value);
  assertNoFillScan(measured.capture);
  if (Object.keys(required).length) assertUnforcedIndexes(name, scale, measured.capture, required);
  return { page: measured.value, capture: measured.capture, cost: costOf(measured.capture) };
}

test('mounted forward relation pages stay bounded with native disclosure as degree and unrelated history grow', async () => {
  const charges: Record<string, { scale: number; rows: number; statements: number; outbound: number }[]> = {
    rejected: [],
    sentinel: [],
    reread: [],
    authority: [],
    deep: [],
    empty: [],
  };

  let issued: PublicCursors | undefined;
  for (const axis of ['degree', 'history'] as const) {
    const prepared = new Set<number>();
    const report = await checkGrowth(db, {
      name: `mounted forward relation ${axis} pages with native disclosure`,
      scales: [...SCALES],
      warmups: 1,
      repetitions: 5,
      includeBackends: true,
      indexProbes,
      bounds,
      grow: axis === 'degree' ? fixture.growDegree : fixture.growHistory,
      async prepare(_database, scale) {
        if (prepared.has(scale)) return;
        const publicCursors =
          axis === 'history' && issued ? issued : await fixture.issuePublicCursors();
        if (axis === 'degree') issued = publicCursors;

        const sentinel = await captureCase(`${axis} sentinel/lookahead`, scale, () => fixture.forward());
        assertDisclosedPage(sentinel.page, scale);
        expect(sentinel.page.relations[0]?.label).toBe(disclosedLabel(0));
        expect(outboundExamined(sentinel.capture)).toBe(PAGE_SIZE + LOOKAHEAD);
        charges.sentinel.push({
          scale,
          rows: sentinel.cost.rows,
          statements: sentinel.cost.statements,
          outbound: outboundExamined(sentinel.capture),
        });

        const reread = await captureCase(`${axis} rereads`, scale, () => fixture.forward());
        assertDisclosedPage(reread.page, scale);
        assertReread(reread.capture);
        charges.reread.push({
          scale,
          rows: reread.cost.rows,
          statements: reread.cost.statements,
          outbound: outboundExamined(reread.capture),
        });

        const authority = await captureCase(`${axis} native authority`, scale, () => fixture.forward());
        assertDisclosedPage(authority.page, scale);
        assertAuthority(authority.cost, authority.capture);
        charges.authority.push({
          scale,
          rows: authority.cost.rows,
          statements: authority.cost.statements,
          outbound: outboundExamined(authority.capture),
        });

        const rejected = await captureCase(`${axis} rejected candidates`, scale, () =>
          fixture.forward({ cursor: publicCursors.rejected }),
        );
        expect(rejected.page.relations.length).toBeGreaterThan(0);
        expect(rejected.page.relations.length).toBeLessThan(PAGE_SIZE);
        expect(rejected.page).not.toHaveProperty('count');
        expect(rejected.page.relations.some((row) => row.target === fixture.hidden.id)).toBe(false);
        expect(rejected.page.relations.some((row) => row.target === fixture.denied.id)).toBe(false);
        expect(outboundExamined(rejected.capture)).toBeLessThanOrEqual(PAGE_SIZE + LOOKAHEAD);
        expect(outboundExamined(rejected.capture)).toBeGreaterThan(rejected.page.relations.length);
        charges.rejected.push({
          scale,
          rows: rejected.cost.rows,
          statements: rejected.cost.statements,
          outbound: outboundExamined(rejected.capture),
        });

        const deep = await captureCase(`${axis} deep page`, scale, () =>
          fixture.forward({ cursor: publicCursors.deep }),
        );
        assertContinuedPage(deep.page, scale);
        charges.deep.push({
          scale,
          rows: deep.cost.rows,
          statements: deep.cost.statements,
          outbound: outboundExamined(deep.capture),
        });

        const empty = await captureCase(
          `${axis} exhausted-empty page`,
          scale,
          () => fixture.forward({ cursor: publicCursors.empty }),
          {},
        );
        assertEmptyPage(empty.page, scale);
        expect(outboundExamined(empty.capture)).toBeLessThanOrEqual(PAGE_SIZE + LOOKAHEAD);
        charges.empty.push({
          scale,
          rows: empty.cost.rows,
          statements: empty.cost.statements,
          outbound: outboundExamined(empty.capture),
        });

        prepared.add(scale);
      },
      async operation(_database, scale) {
        const page = await fixture.forward();
        assertDisclosedPage(page, scale);
        return page;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([...SCALES]);
    logGrowthSeeding(report);
  }

  for (const [name, samples] of Object.entries(charges)) {
    expect(samples.map((sample) => sample.scale).slice(0, SCALES.length)).toEqual([...SCALES]);
    const rows = new Set(samples.filter((sample) => sample.scale === samples[0]!.scale).map((sample) => sample.rows));
    expect(rows.size, `${name} mixed physical work into one capture`).toBeGreaterThan(0);
  }
  console.info('Forward page disclosure per-case charges', JSON.stringify({ probeOperands, indexProbes, charges }));
}, 180_000);
