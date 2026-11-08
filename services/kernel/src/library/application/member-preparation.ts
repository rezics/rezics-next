/** Canonical member preparation. Search owner-leaf checks and identity disclosure stay behind ports. */

import type {
  CollectionSourceObservation,
  IdentityDisclosureCapability,
  LibraryActor,
  MemberPreparationResult,
  MembersWorkDefinition,
  MembersWorkDefinitionCapability,
  OccurrenceDraft,
  SearchPreparationCapability,
} from '../contract/index.ts';
import { admissionTerm, orderedOccurrences, repeatedSubjectCount, sumAdmission } from '../core/index.ts';

/** Members episode getter. Search supplies current-work rechecks around this native read. */
export function createMembersWorkDefinitionApplication<Definition extends MembersWorkDefinition>(
  capability: Readonly<{
    readWorkDefinition: (
      input: Parameters<MembersWorkDefinitionCapability['readWorkDefinition']>[0],
    ) => Promise<Definition | null>;
  }>,
) {
  return {
    readWorkDefinition(
      input: Parameters<MembersWorkDefinitionCapability['readWorkDefinition']>[0],
    ): Promise<Definition | null> {
      return capability.readWorkDefinition(input);
    },
  };
}

export function createMemberPreparationApplication(capabilities: {
  searchPreparation: SearchPreparationCapability;
  identityDisclosure: IdentityDisclosureCapability;
}) {
  return {
    async prepare(input: {
      actor: LibraryActor;
      collectionId: string;
      deadline: number;
      occurrences: readonly OccurrenceDraft[];
      filter?: unknown;
      releaseDigest?: string;
      ownerFence?: string | null;
      observation?: CollectionSourceObservation;
    }): Promise<MemberPreparationResult> {
      const occurrences = orderedOccurrences(input.occurrences);
      const repeats = repeatedSubjectCount(occurrences);
      const ownerLeaf = input.filter ? capabilities.searchPreparation.ownerFilterHasOwnerLeaf(input.filter) : false;
      if (ownerLeaf && (input.ownerFence === undefined || input.ownerFence === null))
        throw new TypeError('Owner-leaf preparation requires a current owner fence.');
      if (input.releaseDigest)
        await capabilities.identityDisclosure.readRelease(undefined, input.releaseDigest, { composed: false });
      const admission = sumAdmission([
        admissionTerm('source-prepare', { nativeRows: 64, nativePoints: 16, statements: 12, bytes: 80 * 1024 }),
        admissionTerm('canonical-members', {
          candidateKeys: occurrences.length,
          nativeRows: occurrences.length * 16,
          nativePoints: occurrences.length * 8,
          witnessKeys: occurrences.length * 8,
          bytes: occurrences.length * 5120,
        }),
        admissionTerm('repeated-occurrences', { candidateKeys: repeats, nativeRows: repeats, bytes: repeats * 256 }),
        ...(ownerLeaf
          ? [admissionTerm('owner-fence', { nativeRows: 1, nativePoints: 1, statements: 1, emptySeeks: 1 })]
          : []),
      ]);
      const ownerFence = input.ownerFence ?? null;
      if (!input.observation) return { status: 'unprepared', admission, ownerFence };
      return {
        status: 'prepared',
        page: {
          occurrences,
          exhausted: true,
          observation: input.observation,
          work: {
            reservationId: 'member-preparation',
            used: {
              candidateKeys: occurrences.length,
              nativeRows: occurrences.length * 16,
              identityMetadataRows: 0,
              emptySeeks: ownerLeaf ? 1 : 0,
              nativePoints: occurrences.length * 8,
              witnessKeys: occurrences.length * 8,
              statements: ownerLeaf ? 13 : 12,
              bytes: 80 * 1024 + occurrences.length * 5120,
            },
          },
        },
        admission,
        ownerFence,
      };
    },
  };
}

export type MemberPreparationApplication = ReturnType<typeof createMemberPreparationApplication>;
