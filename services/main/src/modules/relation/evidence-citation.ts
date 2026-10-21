import { Value } from 'typebox/value';
import { validSuppliedLanguage } from '../source/field-control-language.ts';
import type { PublicRetainedFieldEvidence } from '../source/retained-evidence.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';
import { associationEvidenceCitation, type AssociationEvidenceCitation,
  type RetainedSourceFieldCitation } from './evidence-citation-contract.ts';

/** This input comes from the Source support/evidence owner, after its actual
 * reader, native head and rights checks; it is never a request certificate. */
export interface RetainedSourceFieldCitationInput {
  support: string;
  supportIdentity: string;
  evidence: PublicRetainedFieldEvidence;
}
export function isAssociationEvidenceCitation(value: unknown): value is AssociationEvidenceCitation {
  if (!Value.Check(associationEvidenceCitation, value)) return false;
  if (!('kind' in value)) return true;
  return validSuppliedLanguage(value.language) && !/~(?![01])/.test(value.locator.pointer)
    && (value.quoteWithheld ? value.quote === null : typeof value.quote === 'string' && value.rightsBasis.result === 'supported');
}

/** Projection only: this preserves the owner's actual identities and values.
 * It neither authorizes quotation nor manufactures a native evidence receipt. */
export function projectRetainedAssociationCitation(input: RetainedSourceFieldCitationInput): RetainedSourceFieldCitation {
  const { id: record, ...evidence } = structuredClone(input.evidence);
  const result: RetainedSourceFieldCitation = { kind: 'retained-source-field', id: input.support,
    supportIdentity: input.supportIdentity, record, ...evidence };
  if (!isAssociationEvidenceCitation(result)) throw new WorkReadUnavailable('Retained association evidence is unavailable');
  return result;
}
