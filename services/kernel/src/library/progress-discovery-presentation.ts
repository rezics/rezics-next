import { releaseDigest, validateRelease, type Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { deadlineFor } from '../request/deadline.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';
import { presentProgressSession } from './progress-presentation.ts';
import type { ProgressDiscoveryFact } from './progress-store.ts';
import type { ProgressPresentation, ProgressMeasurePresentation } from './progress-model.ts';
import {
  sessionDiscoveryReleasesPlan,
  sessionPresentationWork,
  consumeSessionWork,
} from './session-operation-bounds.ts';

export type ProgressDiscoveryPresentation = {
  presentation: ProgressPresentation;
  measures: ProgressMeasurePresentation[];
};

/** Present each page from its retained profile snapshot with one bounded release batch. */
export async function presentProgressDiscovery(
  pool: Pool,
  facts: readonly ProgressDiscoveryFact[],
): Promise<Map<string, ProgressDiscoveryPresentation>> {
  if (facts.length > 50) throw new RangeError('Progress discovery presentation accepts at most 50 sessions');
  const digests = [...new Set(facts.flatMap(({ profilePin }) => (profilePin ? [profilePin.releaseDigest] : [])))];
  const snapshots = new Map<string, { digest: string; release: Release }>();
  if (digests.length) {
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    const rows = await withConnection(pool, (client) =>
      sessionDiscoveryReleasesPlan({ digests }).run(deadlineClient(client, deadline)),
    ).catch(() => []);
    for (const row of rows) {
      try {
        if (validateRelease(row.body).length) continue;
        const release = row.body as Release;
        if (releaseDigest(release) === row.digest) snapshots.set(row.digest, { digest: row.digest, release });
      } catch {
        // A missing or malformed historic release leaves its meaning unavailable.
      }
    }
  }
  return consumeSessionWork(
    'discovery-presentation',
    sessionPresentationWork(8, facts.length),
    async () =>
      new Map(
        facts.map(({ session, profilePin }) => {
          const snapshot = profilePin ? (snapshots.get(profilePin.releaseDigest) ?? null) : null;
          const presentation = presentProgressSession({ session, pin: profilePin }, snapshot, null);
          const measures = (session.measures ?? []).map((measure) => ({
            unit: measure.unit,
            presentation: presentProgressSession(
              {
                session: { ...session, unit: measure.unit, amount: measure.amount, total: measure.total },
                pin: profilePin,
              },
              snapshot,
              null,
            ),
          }));
          return [session.id, { presentation, measures }];
        }),
      ),
  );
}
