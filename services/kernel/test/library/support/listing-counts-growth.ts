import { expect } from 'bun:test';
import { subjectListingSource } from '../../../src/library/listing-counts.ts';
import listingCounts from '../../../src/library/listing-counts.sql';
import { newId, partitionOf } from '../../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  seed,
  type GrowthDatabase,
  type GrowthReport,
  type Population,
} from '../../support/growth.ts';

/** Fixed Search batch; k is the supplied-id count, independent of N. */
export const LISTING_COUNT_BATCH = 8;
export const LISTING_COUNT_SCALES = [64, 512, 4096] as const;
/** One home route so same-partition noise stays on the selected subject's partition. */
export const LISTING_COUNT_HOME_ROUTE = 0x4d30;

export type ListingCountInput = 'all-hit' | 'all-miss' | 'mixed';

export type ListingCountBatch = {
  readonly partition: number;
  readonly ids: readonly string[];
  readonly expected: ReadonlyMap<string, number>;
  readonly hits: number;
  readonly foreignId: string;
};

type PlanNode = Record<string, unknown>;

function planNodes(value: unknown): PlanNode[] {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (value === null || typeof value !== 'object') return [];
  const node = value as PlanNode;
  return [...('Node Type' in node ? [node] : []), ...Object.values(node).flatMap(planNodes)];
}

function examinedRows(node: PlanNode): number {
  return (
    (Number(node['Actual Rows']) +
      Number(node['Rows Removed by Filter'] ?? 0) +
      Number(node['Rows Removed by Index Recheck'] ?? 0)) *
    Number(node['Actual Loops'])
  );
}

function historyRows(
  placement: { ordinal: number; route: number; partition: number },
  nonce: string,
  kind: string,
  positionBase: number,
) {
  const transaction = newId(placement.route);
  const position = positionBase + placement.ordinal + 1;
  const principal = newId(placement.route);
  return {
    'core.outbox': [
      {
        partition_no: placement.partition,
        position,
        event_seq: 0,
        event_count: 1,
        epoch: 1,
        id: newId(placement.route),
        type: 'com.rezics.library.subject.listed.v1',
        subject: newId(placement.route),
        data: { nonce, ordinal: placement.ordinal },
      },
    ],
    'editorial.write_basis': [
      {
        partition_no: placement.partition,
        transaction_id: transaction,
        epoch: 1,
        position,
        principal_kind: 'account',
        principal_id: principal,
        client_id: kind,
        requested_by: null,
      },
    ],
    'core.receipt': [
      {
        partition_no: placement.partition,
        principal_kind: 'account',
        principal_id: principal,
        command_kind: kind,
        idempotency_key: `${nonce}-${placement.ordinal}`,
        request_digest: Buffer.alloc(32, 9),
        epoch: 1,
        position,
        transaction_id: transaction,
        response: { publicCollectionCount: 1, revision: 1 },
      },
    ],
  };
}

function listingRow(route: number, count: number) {
  const subjectId = newId(route);
  return {
    route,
    subject_id: subjectId,
    public_collection_count: count,
    revision: 1,
    updated_at: '2026-01-01T00:00:00Z',
    transaction_id: subjectId,
  };
}

/** Same-home listings plus envelope history, then unrelated listings plus history, each grown by `scale`. */
export function listingCountsGrowthPopulations(
  homePartition: number,
  nonce: string,
): {
  readonly sameHome: Population;
  readonly unrelated: Population;
} {
  const kind = `library.listing-counts.growth.${nonce}`;
  const positionBase = 800_000_000 + Math.floor(Math.random() * 10_000_000);
  return {
    sameHome: {
      name: `listing-counts-same-home-${nonce}`,
      hotPartition: homePartition,
      hotShare: 1,
      rows(placement) {
        return {
          'library.subject_listing': [listingRow(placement.route, 1 + (placement.ordinal % 50))],
          ...historyRows(placement, nonce, kind, positionBase),
        };
      },
    },
    unrelated: {
      name: `listing-counts-unrelated-${nonce}`,
      hotPartition: homePartition,
      hotShare: 0,
      rows(placement) {
        return {
          'library.subject_listing': [listingRow(placement.route, 1 + (placement.ordinal % 50))],
          ...historyRows(placement, `${nonce}-unrelated`, kind, positionBase + 20_000_000),
        };
      },
    },
  };
}

export async function growListingCounts(
  db: GrowthDatabase,
  populations: ReturnType<typeof listingCountsGrowthPopulations>,
  scale: number,
  previous: number,
): Promise<void> {
  await seed(db, populations.sameHome, { from: previous, to: scale });
  await seed(db, populations.unrelated, { from: previous, to: scale });
}

export function listingCountBatch(input: ListingCountInput, route = LISTING_COUNT_HOME_ROUTE): ListingCountBatch {
  const ids = Array.from({ length: LISTING_COUNT_BATCH }, () => newId(route));
  const hitCount = input === 'all-hit' ? ids.length : input === 'mixed' ? ids.length / 2 : 0;
  const expected = new Map<string, number>();
  for (let index = 0; index < hitCount; index++) expected.set(ids[index]!, index + 1);
  return {
    partition: partitionOf(route),
    ids,
    expected,
    hits: hitCount,
    foreignId: newId(route + 16),
  };
}

export async function insertListingCountHits(db: GrowthDatabase, batch: ListingCountBatch): Promise<void> {
  const hits = [...batch.expected.entries()];
  if (hits.length === 0) return;
  await db.admin.query(
    `INSERT INTO library.subject_listing
       (route, subject_id, public_collection_count, revision, updated_at, transaction_id)
     SELECT get_byte(uuid_send(id), 10) * 256 + get_byte(uuid_send(id), 11),
            id, count, 1, '2026-01-01T00:00:00Z', id
     FROM unnest($1::uuid[], $2::int[]) AS input(id, count)`,
    [hits.map(([id]) => id), hits.map(([, count]) => count)],
  );
}

export async function readListingCounts(db: GrowthDatabase, batch: ListingCountBatch) {
  return subjectListingSource(db.pool).read(batch.partition, batch.ids);
}

/** Anchors: one listing-counts.sql statement; PK (route, subject_id) LIMIT 1 per supplied id; partition range on route. */
export function assertListingCountReaderWork(report: GrowthReport, batch: ListingCountBatch): void {
  const k = batch.ids.length;
  const sql = listingCounts.sql.replace(/\s+/g, ' ');
  expect(sql).toContain('WITH input AS NOT MATERIALIZED');
  expect(sql).toContain('unnest(');
  expect(sql).toContain('JOIN LATERAL');
  expect(sql).toContain('LIMIT 1');
  const relations = [
    ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((cost) => Object.keys(cost.relations)))),
  ];
  assertGrowthAccessPaths(report.name, report.samples, relations);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(1);
    expect(sample.cost.plans).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeLessThanOrEqual(2 * k);
    expect(sample.cost.relations['library.subject_listing']?.rows ?? 0).toBe(batch.hits);
    expect(sample.cost.relations['library.subject_listing']?.sequentialScans ?? 0).toBe(0);
    expect(sample.cost.sharedHit + sample.cost.sharedRead).toBe(sample.cost.blocks);
    expect(sample.cost.backgroundStatements ?? 0).toBe(0);
    for (const occurrences of sample.occurrenceRepetitions) {
      expect(occurrences.backgroundStatements).toEqual([]);
      const product = occurrences.statements.filter((occurrence) =>
        occurrence.statement.includes('library.subject_listing'),
      );
      expect(product).toHaveLength(1);
      const statement = product[0]!.statement.replace(/\s+/g, ' ');
      expect(statement).toContain('WITH input AS NOT MATERIALIZED');
      expect(statement).toContain('unnest(');
      expect(statement).toContain('JOIN LATERAL');
      expect(statement).toContain('LIMIT 1');
      expect(statement).toMatch(/route >= .*partition_no \* 16/);
      expect(statement).toMatch(/route < \(.*partition_no \+ 1\) \* 16/);
      const nodes = product[0]!.planDocuments.flatMap(planNodes);
      const scans = nodes.filter(
        (node) =>
          node.Schema === 'library' && node['Relation Name'] === 'subject_listing' && Number(node['Actual Loops']) > 0,
      );
      expect(scans).toHaveLength(1);
      const scan = scans[0]!;
      expect(['Index Scan', 'Index Only Scan']).toContain(String(scan['Node Type']));
      expect(scan['Index Name']).toBe('subject_listing_pkey');
      const condition = String(scan['Index Cond']);
      expect(condition).toContain('route');
      expect(condition).toContain('subject_id');
      expect(Number(scan['Actual Loops'])).toBe(k);
      expect(Number(scan['Actual Rows'])).toBeLessThanOrEqual(1);
      expect(Math.round(examinedRows(scan))).toBe(batch.hits);
      expect(Number(scan['Shared Hit Blocks'] ?? 0) + Number(scan['Shared Read Blocks'] ?? 0)).toBeGreaterThan(0);
      expect(
        nodes.some((node) => node['Node Type'] === 'Limit' && Number(node['Actual Loops']) === k) ||
          Number(scan['Plan Rows']) === 1,
      ).toBe(true);
    }
  }
}
