import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import pg from 'pg';
import type { Pool } from 'pg';
import { GrowthSettleInfrastructureError, settleAdmin, vacuumFollows } from './growth-capture.ts';

export type SeedTarget = { readonly pool: Pool; readonly admin: pg.Pool };
export type Row = Readonly<Record<string, unknown>>;
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

const TABLE_NAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const BATCH_SIZE = 1_000;
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

function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    let hex = '';
    for (const byte of value) hex += byte.toString(16).padStart(2, '0');
    return `\\x${hex}`;
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  return value;
}

type TableRows = {
  readonly schema: string;
  readonly table: string;
  columns: string[];
  readonly rows: Row[];
  initialized: boolean;
};

function collect(population: Population, from: number, to: number): TableRows[] {
  const tables = new Map<string, TableRows>();
  for (let ordinal = from; ordinal < to; ordinal++) {
    const placementValue = placement(population, ordinal);
    const records = population.rows!(placementValue);
    for (const [name, rows] of Object.entries(records)) {
      if (!TABLE_NAME.test(name)) throw new Error(`Invalid table name: ${name}`);
      const [schema, table] = name.split('.') as [string, string];
      let target = tables.get(name);
      if (!target) {
        target = { schema, table, columns: [], rows: [], initialized: false };
        tables.set(name, target);
      }
      for (const row of rows) {
        const keys = Object.keys(row);
        if (!keys.length) throw new Error(`Rows for ${name} must include at least one column`);
        if (!target.initialized) {
          target.columns = keys;
          target.initialized = true;
        } else if (keys.length !== target.columns.length || target.columns.some((key) => !Object.hasOwn(row, key)))
          throw new Error(`Rows for ${name} must have identical columns`);
        target.rows.push(row);
      }
    }
  }
  return [...tables.values()];
}

async function insertBatch(admin: pg.Pool, tables: TableRows[]): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    for (const target of tables) {
      if (!target.rows.length) continue;
      const qualified = `${pg.escapeIdentifier(target.schema)}.${pg.escapeIdentifier(target.table)}`;
      const columns = target.columns.map((column) => pg.escapeIdentifier(column)).join(', ');
      const values = JSON.stringify(jsonValue(target.rows));
      await client.query(
        `INSERT INTO ${qualified} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::${qualified}, $1::jsonb)`,
        [values],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function writeRange(target: SeedTarget, population: Population, range: SeedRange): Promise<void> {
  let next = range.from;
  const worker = async (): Promise<void> => {
    while (next < range.to) {
      const ordinal = next++;
      await population.write!(target, placement(population, ordinal));
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, range.to - range.from) }, worker));
}

export async function seed(target: SeedTarget, population: Population, range: SeedRange): Promise<void> {
  assertPopulation(population);
  if (!Number.isSafeInteger(range.from) || range.from < 0 || !Number.isSafeInteger(range.to) || range.to < range.from)
    throw new RangeError('range must contain non-negative safe ordinals with from <= to');
  if (Boolean(population.rows) === Boolean(population.write))
    throw new Error('population must supply exactly one of rows or write');
  if (population.rows) {
    for (let from = range.from; from < range.to; from += BATCH_SIZE) {
      const to = Math.min(from + BATCH_SIZE, range.to);
      await insertBatch(target.admin, collect(population, from, to));
    }
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
