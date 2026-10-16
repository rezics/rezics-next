import type { StagedSourceObservation } from '../source/intake.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import type { CompositionHeader } from './graph.ts';
import type { OccurrenceRecord } from './format.ts';
import { isContainerRole, structureProfileFor } from './profiles.ts';
import { readCompositionPage, readCompositionSnapshot } from './read.ts';
import { PublicationUnavailable } from '../contribution/publish.ts';

/** Profile evidence is an exact correspondence, not a publication or rights grant. */
export interface VerifiedSourceCorrespondence {
  observation: string; structure: string; revision: string;
  attribution: { url: string; author: string | null; license: string | null };
}
export type SourceCorrespondenceVerifier = (input: {
  environment: WorkActivationEnvironment; observation: StagedSourceObservation; header: CompositionHeader;
}) => Promise<VerifiedSourceCorrespondence>;

/** At most the source's declared inventory, in immutable depth-first sibling order.
 * Work admission precedes this private owner read; targets convey no delivery grant.
 */
export async function readSourceCorrespondenceRecords(environment: WorkActivationEnvironment,
  header: CompositionHeader, count: number): Promise<OccurrenceRecord[]> {
  if (!Number.isSafeInteger(count) || count < 1 || header.placementCount !== count)
    throw new PublicationUnavailable('Source inventory differs from Structure');
  const profile = structureProfileFor(header.profile);
  const snapshot = await readCompositionSnapshot(environment, { structure: header.structure,
    header, revision: header.head });
  const records: OccurrenceRecord[] = [];
  const visited = new Set<string>();
  const visit = async (parent: string) => {
    let after: string | undefined;
    do {
      const page = await readCompositionPage(environment, { structure: header.structure, header, snapshot,
        revision: header.head, parent, limit: 100, after, canReadTarget: async () => false,
        canReadOccurrence: async () => true });
      for (const record of page.occurrences) {
        if (records.length >= count || visited.has(record.occurrence))
          throw new PublicationUnavailable('Source inventory exceeds its exact bound');
        records.push(record);
        visited.add(record.occurrence);
        if (isContainerRole(profile, record.role)) await visit(record.occurrence);
      }
      after = page.next ?? undefined;
    } while (after);
  };
  await visit(header.structure);
  if (records.length !== count) throw new PublicationUnavailable('Source inventory is incomplete');
  return records;
}
