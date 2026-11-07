import { MAX_SHELF_PAGE_SIZE } from './contract/index.ts';
import { type ShelfActiveReader, type ShelfSession } from './shelf-contract.ts';
import activeSessions from './shelf-active.sql';
import { executeLabelSql, labelActiveSessionsPlan } from './label-operation-bounds.ts';

function member<T extends string>(value: string, values: readonly T[]): T {
  const matched = values.find((candidate) => candidate === value);
  if (matched === undefined) throw new Error(`Unknown progress value: ${value}`);
  return matched;
}

/** Enrich only the emitted page, using the caller's admitted owning-account snapshot. */
export function createShelfActiveReader(): ShelfActiveReader {
  return {
    async sessions(client, route, accountId, subjectIds) {
      const distinct = new Set<string>();
      for (const subjectId of subjectIds) {
        distinct.add(subjectId);
        if (distinct.size > MAX_SHELF_PAGE_SIZE) throw new RangeError('A shelf page accepts at most 100 subjects');
      }
      const result = new Map<string, ShelfSession>();
      if (distinct.size === 0) return result;

      const plan = labelActiveSessionsPlan({ route, accountId, subjectIds: [...distinct] });
      const rows = await executeLabelSql(plan, (operands) =>
        activeSessions.run({ query: client.query.bind(client) }, operands),
      );
      for (const row of rows) {
        if (row.startedAt === null) throw new Error('Progress session start timestamp is missing');
        // Match progress-store's BASIC serialization, including numeric text and millisecond ISO timestamps.
        result.set(row.subjectId, {
          ...row,
          mode: member(row.mode, ['scalar_amount', 'cursor_position', 'completed_units']),
          unit: row.unit,
          state: member(row.state, ['active']),
          startedAt: new Date(row.startedAt).toISOString(),
          completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
        });
      }
      return result;
    },
  };
}
