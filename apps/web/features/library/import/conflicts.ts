import type { ImportApi, ImportRow, RowResolution } from '../import-api.ts';
import { groupOf } from '../import-rows.ts';

/** The choice a matched source row should carry for the selected conflict policy, or null when it has nothing to carry. */
function desiredResolution(row: ImportRow, useImported: boolean): RowResolution | null {
  const work = row.resolution?.work ?? row.match?.work;
  if (row.source.kind !== 'source' || !work || groupOf(row) !== 'matched') return null;
  const target = row.resolution?.target ?? row.match?.target;
  return { choice: 'apply', work, ...target ? { target } : {}, ...useImported ? { conflictChoice: 'replace' } : {} };
}

/**
 * Save the conflict policy on every row before apply seals. Main applies `replace` for the rows that hold it, so a
 * choice saved by an earlier, interrupted preparation must be undone when the reader now keeps their own values.
 */
export async function reconcileConflictChoices(api: Pick<ImportApi, 'resolve'>, id: string, rows: readonly ImportRow[],
  useImported: boolean, signal: AbortSignal): Promise<void> {
  for (const row of rows) {
    signal.throwIfAborted();
    const wanted = desiredResolution(row, useImported);
    if (!wanted || (row.resolution?.conflictChoice === 'replace') === useImported) continue;
    await api.resolve(id, row, wanted, { signal });
  }
}
