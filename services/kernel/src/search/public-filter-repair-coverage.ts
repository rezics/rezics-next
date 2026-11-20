import type { PublicFilterProjectionRecord } from '../semantic/public-filter-source-contract.ts';
import type { PublicCanonicalCaptureInput } from './public-filter-consumer-contract.ts';

export type RepairCoverageScope = Readonly<{
  capture: PublicCanonicalCaptureInput;
  subjectPublication: boolean;
}>;

/** Complete all-key Subject repair uses the ordinary writer and has no membership predicate to prove. */
export function hasDispatchableRepairCoverage(
  records: readonly Pick<PublicFilterProjectionRecord, 'indexed'>[],
  { capture, subjectPublication }: RepairCoverageScope,
): boolean {
  if (!records.some((row) => row.indexed === null)) return true;
  // These records remain not_proven for matcher coverage in either polarity.
  return (
    subjectPublication &&
    !('representation' in capture) &&
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
