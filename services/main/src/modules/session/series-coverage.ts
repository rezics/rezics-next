import { WorkReadMissing, type WorkReadSession } from '../work/read-session.ts';
import type { CoveragePin } from './series-policy.ts';

/** One deduplicated readability pass across all editions and disclosed parts.
 * The owner admits 64 references per batch; each Work is checked once. */
export async function readableSeriesCoverage(session: Pick<WorkReadSession, 'summaries'>,
  works: string[], candidates: CoveragePin[]) {
  const check = [...new Set([...works, ...candidates.flatMap(pin => pin.entries.map(entry => entry.work))])];
  const readable = new Map<string, boolean>();
  for (let offset = 0; offset < check.length; offset += 64) {
    for (const row of await session.summaries(check.slice(offset, offset + 64))) {
      readable.set(row.reference, row.status === 'available');
    }
  }
  if (works.some(work => !readable.get(work))) throw new WorkReadMissing('Progress inputs are unavailable');
  return candidates.filter(pin => pin.entries.every(entry => readable.get(entry.work)));
}
