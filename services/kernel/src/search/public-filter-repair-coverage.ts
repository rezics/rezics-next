import { BOOK_CATALOGUE_TYPES } from '@rezics/definitions/contract';
import type { PublicFilterProjectionRecord } from '../semantic/public-filter-source-contract.ts';
import type { PublicCanonicalCaptureInput } from './public-filter-consumer-contract.ts';

export type RepairCoverageScope = Readonly<{
  capture: PublicCanonicalCaptureInput;
  subjectPublication: boolean;
  mixedPreparation: boolean;
}>;

/** A complete Source projection can dispatch keyed repair when its capture needs no scalar statement match. */
export function hasDispatchableRepairCoverage(
  records: readonly Pick<PublicFilterProjectionRecord, 'indexed'>[],
  { capture, subjectPublication, mixedPreparation }: RepairCoverageScope,
): boolean {
  if (!records.some((row) => row.indexed === null)) return true;
  // These records remain not_proven for matcher coverage in either polarity.
  if ('representation' in capture) {
    const filter = capture.filterDocument;
    return (
      mixedPreparation &&
      capture.representation === 'discovery-v1' &&
      capture.comparator === 'mixed-public-v1' &&
      capture.sort === 'name' &&
      capture.text === undefined &&
      capture.textField === undefined &&
      capture.creditQualifiers === undefined &&
      capture.query === undefined &&
      capture.boost === undefined &&
      capture.after === undefined &&
      filter !== undefined &&
      'kind' in filter &&
      filter.kind.in.length === BOOK_CATALOGUE_TYPES.length &&
      BOOK_CATALOGUE_TYPES.every((kind) => filter.kind.in.includes(kind))
    );
  }
  return (
    subjectPublication &&
    'sort' in capture &&
    capture.sort === 'id' &&
    capture.filterDocument === undefined &&
    capture.text === undefined &&
    capture.filter === undefined &&
    capture.query === undefined &&
    capture.boost === undefined &&
    capture.after === undefined
  );
}
