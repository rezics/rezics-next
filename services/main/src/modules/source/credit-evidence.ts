import type { NativeCreditRole } from '../work/read-contract.ts';
import type { StagedSourceObservation } from './intake.ts';
import type { MappedConversionReader } from './mapped-values.ts';

/** A provider adapter verifies retained bytes and reports qualified participants.
 * Source role keys remain evidence; the mapped native role is a separate value. */
export interface VerifiedCreditOccurrence {
  provider: string; namespace: string; sourceKey: string; role: NativeCreditRole; roleKey: string | null;
}
export interface CreditEvidenceReader extends MappedConversionReader {
  verifiedRead(principal: string, conversion: string): Promise<{
    observation: StagedSourceObservation;
    credits: VerifiedCreditOccurrence[] | null;
    conversion: { conversion: string; observation: string;
      projection: { authorRefs: Array<{ sourceKey: string; roleKey: string | null }> | null; subjects: string[] | null };
      fieldInventory: Array<{ field: string; disposition: string }> };
  } | null>;
}
