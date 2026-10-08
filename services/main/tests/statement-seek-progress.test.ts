import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { StatementSeek } from '../src/modules/statement/seek.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
const meaning = `urn:rezics:meaning:${'ab'.repeat(32)}`;
const epoch = 'epoch';
interface Coverage { through: bigint; complete: boolean }
interface Options {
  position: bigint;
  coverage: Coverage | null;
  /** The unheld position proof sees no row while a restore hold is in force. */
  restoreHold?: boolean;
  populated?: boolean;
  outbox?: (sequences: string[]) => { sequence: { value: string } }[];
  changed?: string[];
  /** May move the graph after a position read. The read count starts at 1. */
  afterPosition?: (read: number, current: bigint) => bigint;
  /** Runs inside the open projection transaction, when the outbox batch is read. */
  duringBatch?: (coverage: Coverage) => void;
}

function harness(options: Options) {
  let position = options.position;
  let reads = 0;
  let coverage = options.coverage ? { ...options.coverage } : null;
  let tx: { coverage: Coverage | null; indexed: Set<string> } | null = null;
  const indexed = new Set<string>();
  const updates: bigint[] = [];
  const view = () => tx ? tx.coverage : coverage;
  const indexedView = () => tx ? tx.indexed : indexed;
  const client = {
    async query(text: string, params: unknown[] = []) {
      if (text === 'BEGIN') {
        tx = { coverage: coverage ? { ...coverage } : null, indexed: new Set(indexed) };
        return { rows: [] };
      }
      if (text === 'COMMIT') {
        coverage = tx!.coverage;
        indexed.clear();
        for (const item of tx!.indexed) indexed.add(item);
        tx = null;
        return { rows: [] };
      }
      if (text === 'ROLLBACK') { tx = null; return { rows: [] }; }
      if (text.includes('recovery_fence') || text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('FROM access.statement_seek_coverage')) {
        const row = view();
        return { rows: row ? [{ through_sequence: row.through.toString(), complete: row.complete }] : [] };
      }
      if (text.includes('UPDATE access.statement_seek_coverage') && text.includes('through_sequence')) {
        const row = view();
        const next = BigInt(String(params[1]));
        updates.push(next);
        if (row) row.through = text.includes('GREATEST') && row.through > next ? row.through : next;
        return { rows: [] };
      }
      if (text.includes('INSERT INTO access.statement_seek_coverage')) {
        if (!coverage) coverage = { through: BigInt(String(params[1])), complete: true };
        return { rows: [] };
      }
      if (text.includes('INSERT INTO access.statement_seek')) {
        indexedView().add(String(params[4]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    query: (text: string, params?: unknown[]) => client.query(text, params),
    connect: async () => client,
  } as unknown as Pool;
  const fuseki = {
    async query(sparql: string) {
      if (sparql.includes('ASK')) return { boolean: options.populated === true };
      if (sparql.includes('OutboxBatch')) {
        const requested = sparql.match(/VALUES \?sequence \{ ([^}]+) \}/)?.[1]?.trim().split(/\s+/) ?? [];
        if (tx?.coverage) options.duringBatch?.(tx.coverage);
        const rows = options.outbox
          ? options.outbox(requested)
          : requested.map(sequence => ({ sequence: { value: sequence }, batch: { value: `urn:rezics:outbox:${sequence}` } }));
        return { results: { bindings: rows } };
      }
      if (sparql.includes('StatementRevision')) {
        return { results: { bindings: (options.changed ?? [id(1)]).map(statement => ({ statement: { value: statement } })) } };
      }
      if (sparql.includes('SemanticRevision')) return { results: { bindings: [] } };
      if (sparql.includes('statementState')) {
        const statement = options.changed?.[0] ?? id(1);
        return { results: { bindings: [{
          statement: { value: statement }, subject: { value: id(2) },
          predicate: { value: 'https://example.org/fact' }, key: { value: meaning }, head: { value: id(3) },
        }] } };
      }
      if (sparql.includes('rv:sequence')) {
        if (options.restoreHold && sparql.includes('restoreHold')) return { results: { bindings: [] } };
        reads += 1;
        position = options.afterPosition?.(reads, position) ?? position;
        return { results: { bindings: [{ sequence: { value: position.toString() } }] } };
      }
      throw new Error(`unexpected graph query: ${sparql.slice(0, 160)}`);
    },
  };
  return {
    seek: new StatementSeek(pool, { lineage: { dataEpoch: epoch }, fuseki } as unknown as WorkActivationEnvironment),
    coverage: () => coverage, indexed, updates,
  };
}

test('Statement projection commits the batch it read when the graph moves and continues from that sequence', async () => {
  const run = harness({
    position: 20n,
    coverage: { through: 10n, complete: true },
    afterPosition: (read, current) => read === 2 ? 30n : current,
  });
  expect(await run.seek.projectOnce()).toBe(true);
  expect(run.coverage()).toEqual({ through: 20n, complete: true });
  expect(run.updates).toEqual([20n]);
  expect(run.indexed.has(id(1))).toBe(true);
  expect(await run.seek.projectOnce()).toBe(true);
  expect(run.coverage()?.through).toBe(30n);
  expect(run.updates).toEqual([20n, 30n]);
  expect(await run.seek.projectOnce()).toBe(false);
  expect(run.coverage()?.through).toBe(30n);
});

test('Statement projection does not move coverage behind a sequence already committed during the batch', async () => {
  const run = harness({
    position: 20n,
    coverage: { through: 10n, complete: true },
    duringBatch: row => { row.through = 25n; },
  });
  expect(await run.seek.projectOnce()).toBe(true);
  expect(run.updates).toEqual([20n]);
  expect(run.coverage()?.through).toBe(25n);
});

test('Statement projection still refuses an incomplete outbox batch without advancing coverage', async () => {
  const run = harness({
    position: 12n,
    coverage: { through: 10n, complete: true },
    changed: [],
    outbox: sequences => sequences.slice(1).map(sequence => ({ sequence: { value: sequence } })),
  });
  await expect(run.seek.projectOnce()).rejects.toThrow('Statement index outbox coverage is incomplete');
  expect(run.coverage()).toEqual({ through: 10n, complete: true });
  expect(run.updates).toEqual([]);
  expect(run.indexed.size).toBe(0);
});

test('an empty Statement epoch still refuses to record coverage when its position moves', async () => {
  const run = harness({
    position: 4n,
    coverage: null,
    populated: false,
    afterPosition: (read, current) => read === 2 ? 5n : current,
  });
  await expect(run.seek.projectOnce()).rejects.toThrow('Empty Statement source position moved');
  expect(run.coverage()).toBeNull();
});

test('Statement projection still refuses while a restore hold hides the source position', async () => {
  const run = harness({ position: 8n, coverage: { through: 8n, complete: true }, restoreHold: true });
  await expect(run.seek.projectOnce()).rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(run.seek.projectOnce()).rejects.toThrow('Statement index source position is unavailable');
  expect(run.coverage()?.through).toBe(8n);
});
