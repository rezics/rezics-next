import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import pg from 'pg';
import type { Pool } from 'pg';
import { GrowthSettleInfrastructureError, settleAdmin, vacuumFollows } from './growth-capture.ts';
import { seedBulkRows, type SeedRow } from './growth-seed-batches.ts';

export type SeedTarget = { readonly pool: Pool; readonly admin: pg.Pool };
export type Row = SeedRow;
export type Placement = {
  readonly ordinal: number;
  readonly route: number;
  readonly partition: number;
  readonly hot: boolean;
};
export type SeedRange = { readonly from: number; readonly to: number };
export type Population = {
  readonly name: string;
  readonly hotPartition: number;
  /** Share of ordinals in hotPartition, 0..1; default 0.5. */
  readonly hotShare?: number;
  /** Bulk rows for one ordinal keyed by "schema.table"; tables are inserted in order of first appearance. */
  rows?(placement: Placement): Readonly<Record<string, readonly Row[]>>;
  /** A production write path for one ordinal, used instead of rows. */
  write?(target: SeedTarget, placement: Placement): Promise<void>;
  /** Bulk SQL that restores derived state after a range is inserted, such as partition positions. */
  finish?(admin: pg.Pool, range: SeedRange): Promise<void>;
};

const WRITE_CONCURRENCY = 4;

function assertOrdinal(ordinal: number): void {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0)
    throw new RangeError('ordinal must be a non-negative safe integer');
}

function assertPopulation(population: Population): void {
  if (!Number.isInteger(population.hotPartition) || population.hotPartition < 0 || population.hotPartition > 4095)
    throw new RangeError('hotPartition must be an integer from 0 through 4095');
  const share = population.hotShare ?? 0.5;
  if (!Number.isFinite(share) || share < 0 || share > 1) throw new RangeError('hotShare must be from 0 through 1');
}

export function placement(population: Population, ordinal: number): Placement {
  assertPopulation(population);
  assertOrdinal(ordinal);
  const share = population.hotShare ?? 0.5;
  const hot = Math.floor((ordinal + 1) * share) > Math.floor(ordinal * share);
  const digest = createHash('sha256').update(`${population.name}\n${ordinal}`).digest();
  const hash = digest.readUInt32BE(0);
  let route: number;
  if (hot) {
    route = population.hotPartition * 16 + (hash % 16);
  } else {
    route = hash % 65_536;
    while (route >>> 4 === population.hotPartition) route = (route + 16) % 65_536;
  }
  return { ordinal, route, partition: route >>> 4, hot };
}

async function writeRange(target: SeedTarget, population: Population, range: SeedRange): Promise<void> {
  let next = range.from;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && next < range.to) {
      const ordinal = next++;
      try {
        await population.write!(target, placement(population, ordinal));
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, range.to - range.from) }, worker));
  if (failed) throw failure;
}

export async function seed(target: SeedTarget, population: Population, range: SeedRange): Promise<void> {
  assertPopulation(population);
  if (!Number.isSafeInteger(range.from) || range.from < 0 || !Number.isSafeInteger(range.to) || range.to < range.from)
    throw new RangeError('range must contain non-negative safe ordinals with from <= to');
  if (Boolean(population.rows) === Boolean(population.write))
    throw new Error('population must supply exactly one of rows or write');
  if (population.rows) {
    await seedBulkRows(
      target.admin,
      range.from,
      range.to,
      (ordinal) => placement(population, ordinal),
      (placementValue) => population.rows!(placementValue),
    );
  } else {
    await writeRange(target, population, range);
  }
  if (population.finish) await population.finish(target.admin, range);
  if (!vacuumFollows(target.admin)) {
    try {
      await settleAdmin(target.admin, { analyze: true });
    } catch (error) {
      if (!(error instanceof GrowthSettleInfrastructureError)) throw error;
      process.stderr.write(
        `GROWTH_REVIEW ${JSON.stringify({
          file: relative(process.cwd(), Bun.main),
          check: 'seed',
          metric: 'settle',
          bound: null,
          rule: 'seed',
          reason: 'settle',
          medians: [],
          ranges: [],
          uncertainties: [],
          repetitions: [],
          settleFailures: [error.message.slice(0, 2000)],
        })}\n`,
      );
    }
  }
}
