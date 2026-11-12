import type { Actor } from '../../request/access.ts';
import { ContentNotFoundError } from '../reads.ts';
import { InvalidHostedStructureError } from '../hosted-chapters-model.ts';
import { resolveHostedOccurrence, resolveHostedOccurrenceMetadata } from '../hosted-chapters-reads.ts';
import type { HostedDependencies } from '../hosted-chapters-model.ts';
import type {
  HostedReadingAddress,
  HostedReadingMetadata,
  HostedReadingPort,
  HostedReadingResume,
  HostedReadingValidation,
} from '../../library/contract/index.ts';
import { hostedReadingSelectionShape, hostedReadingUnavailable } from '../hosted-reading-shape.ts';

export {
  hostedReadingPositionIsBounded,
  hostedReadingSelectionShape,
  hostedReadingUnavailable,
} from '../hosted-reading-shape.ts';

function unavailable(occurrenceId: string, kind: HostedReadingResume['kind'] = 'unknown'): HostedReadingResume {
  return hostedReadingUnavailable(occurrenceId, kind);
}

async function resolve(
  deps: HostedDependencies,
  actor: Actor,
  address: HostedReadingAddress,
  deadline: number,
): Promise<HostedReadingResume> {
  try {
    const result = await resolveHostedOccurrence(
      deps,
      address.catalogueId,
      address.occurrenceId,
      { revisionId: address.publicationRevisionId, kind: 'publication' },
      { actor, deadline },
    );
    const occurrence = result.value.occurrence;
    if (result.value.revisionId !== address.publicationRevisionId) return unavailable(address.occurrenceId);
    if (occurrence.availability !== 'available' || occurrence.kind !== 'chapter' || !result.value.document)
      return unavailable(address.occurrenceId, occurrence.kind);
    if (
      occurrence.target.revisionId !== address.targetRevisionId ||
      occurrence.target.sha256 !== address.targetSha256 ||
      result.value.document.sha256 !== address.targetSha256
    )
      return unavailable(address.occurrenceId, 'chapter');
    return {
      availability: 'available',
      occurrenceId: occurrence.occurrenceId,
      parentId: occurrence.parentId,
      position: occurrence.position,
      kind: 'chapter',
      title: occurrence.title,
      target: occurrence.target,
      document: result.value.document,
    };
  } catch (error) {
    if (error instanceof ContentNotFoundError || error instanceof InvalidHostedStructureError)
      return unavailable(address.occurrenceId);
    throw error;
  }
}

/** Content mapper for Library hosted reading. Validates exact publication selections
 * before save and rechecks current catalogue/target Access on resume. */
export function createNativeHostedReadingPort(deps: HostedDependencies): HostedReadingPort {
  return {
    async validateSelection(actor, selection, deadline): Promise<HostedReadingValidation> {
      if (!hostedReadingSelectionShape(selection)) return { ok: false, reason: 'invalid_selection' };
      const resume = await resolve(deps, actor as Actor, selection, deadline);
      if (resume.availability !== 'available')
        return { ok: false, reason: resume.kind === 'unknown' ? 'not_found' : 'unavailable' };
      return {
        ok: true,
        address: {
          catalogueId: selection.catalogueId,
          publicationRevisionId: selection.publicationRevisionId,
          occurrenceId: selection.occurrenceId,
          targetRevisionId: resume.target.revisionId,
          targetSha256: resume.target.sha256,
          documentPosition: selection.documentPosition,
        },
      };
    },
    async resolveExact(actor, address, deadline): Promise<HostedReadingResume> {
      if (!hostedReadingSelectionShape(address)) return unavailable(address.occurrenceId);
      return resolve(deps, actor as Actor, address, deadline);
    },
    async readMetadata(actor, address, deadline): Promise<HostedReadingMetadata> {
      if (!hostedReadingSelectionShape(address)) return hostedReadingUnavailable(address.occurrenceId);
      try {
        const result = await resolveHostedOccurrenceMetadata(
          deps,
          address.catalogueId,
          address.occurrenceId,
          { revisionId: address.publicationRevisionId, kind: 'publication' },
          { actor: actor as Actor, deadline },
        );
        const occurrence = result.value.occurrence;
        if (result.value.revisionId !== address.publicationRevisionId)
          return hostedReadingUnavailable(address.occurrenceId);
        if (occurrence.availability !== 'available')
          return hostedReadingUnavailable(address.occurrenceId, occurrence.kind);
        if (occurrence.kind !== 'chapter') return hostedReadingUnavailable(address.occurrenceId, 'part');
        if (
          occurrence.target.revisionId !== address.targetRevisionId ||
          occurrence.target.sha256 !== address.targetSha256
        )
          return hostedReadingUnavailable(address.occurrenceId, 'chapter');
        return {
          availability: 'available',
          occurrenceId: occurrence.occurrenceId,
          parentId: occurrence.parentId,
          position: occurrence.position,
          kind: 'chapter',
          title: occurrence.title,
          target: occurrence.target,
        };
      } catch (error) {
        if (error instanceof ContentNotFoundError || error instanceof InvalidHostedStructureError)
          return hostedReadingUnavailable(address.occurrenceId);
        throw error;
      }
    },
  };
}
