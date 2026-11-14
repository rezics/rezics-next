import { releaseDigest, validateRelease, type Release } from '@rezics/definitions';
import type { Pool } from 'pg';
import { AccessUnavailableError } from '../access/contract/errors.ts';
import { withBoundedReadConnection } from '../database/pool.ts';
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
  deadline: number,
): Promise<Map<string, ProgressDiscoveryPresentation>> {
  if (facts.length > 50) throw new RangeError('Progress discovery presentation accepts at most 50 sessions');
  const digests = [...new Set(facts.flatMap(({ profilePin }) => (profilePin ? [profilePin.releaseDigest] : [])))];
  const snapshots = new Map<string, { digest: string; release: Release }>();
  if (digests.length) {
    const rows = await withBoundedReadConnection(
      pool,
      deadline,
      (client) => sessionDiscoveryReleasesPlan({ digests }).run(client),
      {
        deadlineError: () => new AccessUnavailableError('deadline'),
        // The lifetime keeps settled server errors distinct from uncertain transport failures.
        isUncertainSettledQueryError: () => true,
      },
    );
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
