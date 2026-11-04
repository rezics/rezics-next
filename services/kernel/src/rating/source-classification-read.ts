import type { SourceFence } from '../content/source-fences.ts';
import type {
  ClassificationAssociation,
  ClassificationPayload,
  ImmutableClassificationObservation,
  SourceClassificationFigure,
  SourceClassificationRead,
} from './source-classification-contract.ts';
import type { ClassificationAssociationResolution } from './source-classification-semantic.ts';
import type { ClassificationHead } from './source-classification-store.ts';

export function classificationEvidence(value: ClassificationAssociationResolution | undefined) {
  return value?.state === 'available' ? value.evidence : null;
}
export function classificationProvenanceMatches(
  resolution: ClassificationAssociationResolution | undefined,
  value: ClassificationPayload,
) {
  const evidence = classificationEvidence(resolution);
  if (!evidence) return false;
  return (
    !evidence.source ||
    (evidence.source.source === value.sourceAlias &&
      evidence.source.external_id === value.sourceRecordId &&
      evidence.source.field_group === 'facts')
  );
}
function sameFence(a: SourceFence | undefined, b: SourceFence | undefined) {
  return !!a && !!b && !a.takenDown && !b.takenDown && a.securityRevision === b.securityRevision;
}
function toFigure(
  association: ClassificationAssociation,
  observation: ImmutableClassificationObservation,
  now: Date,
): SourceClassificationFigure | null {
  const payload = observation.payload;
  if ('cleared' in payload) return null;
  return {
    provider: 'vndb',
    association,
    observation: { digest: observation.digest, sourceVersion: payload.sourceVersion },
    sourceAlias: payload.sourceAlias,
    sourceRecordId: payload.sourceRecordId,
    sourceAssociationId: payload.sourceAssociationId,
    confidence:
      payload.confidence === undefined
        ? { state: 'unavailable', reason: 'not_supplied' }
        : { state: 'available', value: payload.confidence, unit: 'vndb-tag-rating', minExclusive: 0, max: 3 },
    lie:
      payload.lie === undefined
        ? { state: 'unavailable', reason: 'not_supplied' }
        : { state: 'available', value: payload.lie, unit: 'boolean' },
    ...(payload.confidenceCount === undefined ? {} : { confidenceCount: payload.confidenceCount }),
    ...(payload.lieCount === undefined ? {} : { lieCount: payload.lieCount }),
    asOf: payload.asOf,
    ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(payload.asOf)) / 1000)),
    attribution: payload.attribution,
    licence: payload.licence,
  };
}

/** Compare all selected witnesses before returning either a figure or an admitted empty observation. */
export function currentClassificationRead(input: {
  association: ClassificationAssociation;
  before: ClassificationAssociationResolution | undefined;
  after: ClassificationAssociationResolution | undefined;
  first: ClassificationHead | undefined;
  last: ClassificationHead | undefined;
  fenceBefore: SourceFence | undefined;
  fenceAfter: SourceFence | undefined;
  now: Date;
}): SourceClassificationRead {
  const { before, after, first, last } = input;
  if (before?.state !== 'available') return before ?? { state: 'unavailable', reason: 'authority_unavailable' };
  if (after?.state !== 'available') return after ?? { state: 'unavailable', reason: 'authority_unavailable' };
  if (before.evidence.stamp !== after.evidence.stamp || first?.digest !== last?.digest)
    return { state: 'unavailable', reason: 'changed' };
  if (!first || 'cleared' in first.payload) return { state: 'unavailable', reason: 'not_observed' };
  if (!classificationProvenanceMatches(before, first.payload) || !classificationProvenanceMatches(after, first.payload))
    return { state: 'unavailable', reason: 'provenance_unavailable' };
  if (!sameFence(input.fenceBefore, input.fenceAfter)) return { state: 'unavailable', reason: 'not_found' };
  return { state: 'available', value: toFigure(input.association, first, input.now)! };
}
