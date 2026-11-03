import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import {
  assertGrowthAccessPaths,
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

setDefaultTimeout(600_000);

const SELECTED = PAGE_SIZE;
const SELECTED_SLOT_FACTS = 1;
const TARGET_LABELS = 1;
const PAGE_PARTITIONS = 1;
const ADMITTED = SELECTED + LOOKAHEAD;
// Mounted GET /v1/subjects/:id/relations: one outbound keyset of s+1, one counter,
// selected compact slots, one summary fill per page partition, Access per related id,
// then a released-snapshot reread of those same slots and native fence points.
const probeOperands = {
  holderVisibility: 2,
  partitionHead: 1,
  freshnessCheckpoint: 1,
  outboundSeeks: ADMITTED,
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

type Charge = { scale: number; rows: number; statements: number; outbound: number };

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

function outboundNodes(raw: Capture): Record<string, unknown>[] {
  return nodes(raw.plans).filter(
    (node) => node['Relation Name'] === 'outbound_link' && Number(node['Actual Loops'] ?? 0) > 0,
  );
}

function outboundExamined(raw: Capture): number {
  return outboundNodes(raw).reduce((total, node) => total + examined(node), 0);
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

function assertDisclosedPage(page: ForwardPage, _scale: number, size = PAGE_SIZE): void {
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

function assertContinuedPage(page: ForwardPage, _scale: number): void {
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

function assertFiniteAdmission(raw: Capture): void {
  const sql = raw.statements.join('\n');
  expect(sql).not.toMatch(/enable_seqscan|set_config\s*\(/i);
  for (const node of outboundNodes(raw)) {
    expect(node['Node Type']).not.toBe('Seq Scan');
    expect(examined(node)).toBeLessThanOrEqual(ADMITTED);
  }
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

function assertConstantCharge(name: string, samples: Charge[]): void {
  expect(samples.length % SCALES.length, `${name} missing a scale`).toBe(0);
  for (let offset = 0; offset < samples.length; offset += SCALES.length) {
    const chunk = samples.slice(offset, offset + SCALES.length);
    expect(chunk.map((sample) => sample.scale)).toEqual([...SCALES]);
    expect(new Set(chunk.map((sample) => sample.rows)).size, `${name} rows grew with scale`).toBe(1);
    expect(new Set(chunk.map((sample) => sample.statements)).size, `${name} statements grew with scale`).toBe(1);
  }
}

async function captureCase(
  name: string,
  scale: number,
  operation: () => Promise<ForwardPage>,
  required: typeof covering | Record<string, never> = covering,
): Promise<{ page: ForwardPage; capture: Capture; cost: Cost }> {
  const measured = await capture(db, operation, { includeBackends: true });
  report(name, scale, measured.capture, measured.value);
  assertFiniteAdmission(measured.capture);
  if (Object.keys(required).length) assertUnforcedIndexes(name, scale, measured.capture, required);
  return { page: measured.value, capture: measured.capture, cost: costOf(measured.capture) };
}

test('mounted forward relation pages stay bounded with native disclosure as degree and unrelated history grow', async () => {
  const charges: Record<'rejected' | 'sentinel' | 'reread' | 'authority' | 'deep' | 'empty', Charge[]> = {
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
      async warmup(_database, scale) {
        if (prepared.has(scale)) return;
        const publicCursors = axis === 'history' && issued ? issued : await fixture.issuePublicCursors();
        if (axis === 'degree') issued = publicCursors;

        const sentinel = await captureCase(`${axis} sentinel/lookahead`, scale, () => fixture.forward());
        assertDisclosedPage(sentinel.page, scale);
        expect(sentinel.page.relations[0]?.label).toBe(disclosedLabel(0));
        expect(outboundExamined(sentinel.capture)).toBeGreaterThan(0);
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
        expect(publicCursors.deep).not.toBe(publicCursors.rejected);
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
        charges.empty.push({
          scale,
          rows: empty.cost.rows,
          statements: empty.cost.statements,
          outbound: outboundExamined(empty.capture),
        });

        prepared.add(scale);
      },
      async operation(_database, scale) {
        const publicCursors = issued;
        if (!publicCursors) throw new Error(`Public cursors missing before ${axis} operation at ${scale}`);
        const first = await fixture.forward();
        assertDisclosedPage(first, scale);
        const rejected = await fixture.forward({ cursor: publicCursors.rejected });
        expect(rejected.relations.length).toBeGreaterThan(0);
        expect(rejected.relations.length).toBeLessThan(PAGE_SIZE);
        const deep = await fixture.forward({ cursor: publicCursors.deep });
        assertContinuedPage(deep, scale);
        const empty = await fixture.forward({ cursor: publicCursors.empty });
        assertEmptyPage(empty, scale);
        return { first, rejected, deep, empty };
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([...SCALES]);
    expect(report.verdicts.statements.outcome).toBe('compatible');
    expect(report.verdicts.rows.outcome).toBe('compatible');
    expect(report.verdicts.blocks.outcome).toBe('compatible');
    const relations = [
      ...new Set(
        report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
      ),
    ];
    assertGrowthAccessPaths(report.name, report.samples, relations);
    logGrowthSeeding(report);
  }

  for (const [name, samples] of Object.entries(charges)) assertConstantCharge(name, samples);
  console.info('Forward page disclosure per-case charges', JSON.stringify({ probeOperands, indexProbes, charges }));
}, 600_000);
