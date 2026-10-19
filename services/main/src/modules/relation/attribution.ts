import type { VerifiedPrincipal } from '../access/admission.ts';
import { PendingActivation } from '../work/activate.ts';
import { SemanticChangeRejected } from '../semantic/command.ts';
import type { CreditAttributionField, CreditAttributionSupport } from '../work/credit-association-state.ts';
import type { ExactDefinition } from './change.ts';
import type { Participation } from './schema.ts';
import { canonicalAttribution, type AttributedParticipation } from './v2-schema.ts';

export interface RelationAttributionRequest {
  participation: Participation;
  support: CreditAttributionSupport;
}
export interface RelationAttributionProof {
  basis: CreditAttributionSupport['basis'];
  receipt: string;
  revision: string;
  validationToken: string;
  state: 'current' | 'withdrawn';
  fields: Partial<Record<CreditAttributionField, unknown>>;
  evidence: string[];
  /** An independently admitted native correspondence, never a provider key/name match. */
  participant: Participation['participant'];
}
/** Trusted Source/credit/publication operation. A caller cannot submit a proof or a graph guard. */
export interface RelationAttributionOwner {
  verify(input: { principal: VerifiedPrincipal; actingSubject: string; definition: ExactDefinition;
    participations: readonly AttributedParticipation[];
    requests: readonly RelationAttributionRequest[] }): Promise<{ proofs: RelationAttributionProof[]; guard: string } | null>;
}
export type RelationAttributionVerifier = (definition: ExactDefinition,
  participations: readonly AttributedParticipation[]) => Promise<{ proofs: RelationAttributionProof[]; guard: string }>;

export function relationAttributionVerifier(owner: RelationAttributionOwner | undefined,
  principal: VerifiedPrincipal | null, actingSubject: string | undefined): RelationAttributionVerifier {
  return async (definition, participations) => {
    const requests = participations.flatMap(participation => participation.attributionSupports.map(support => ({ participation, support })));
    if (!requests.length) return { proofs: [], guard: '' };
    if (!owner || !principal || !actingSubject) throw new PendingActivation('exact Source/credit/publication attribution owner is unavailable');
    const verified = await owner.verify({ principal, actingSubject, ...structuredClone({ definition, participations, requests }) });
    if (!verified) throw new SemanticChangeRejected('unavailable-reference', 'a referenced attribution is unavailable');
    if (verified.proofs.length !== requests.length || !verified.guard.trim()) throw new PendingActivation('attribution owner receipt or current support guard is unavailable');
    const proofs = verified.proofs.map<RelationAttributionProof>((proof, index) => {
      const { participation, support } = requests[index]!;
      if (proof.state !== 'current') throw new SemanticChangeRejected('unavailable-reference', 'a referenced attribution is unavailable');
      if (!/^urn:rezics:receipt:[0-9a-f]{64}$/.test(proof.receipt)
        || !/^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(proof.revision)
        || !/^[0-9a-f]{64}$/.test(proof.validationToken)
        || canonicalAttribution(proof.basis) !== canonicalAttribution(support.basis)
        || canonicalAttribution(proof.participant) !== canonicalAttribution(participation.participant)
        || canonicalAttribution([...proof.evidence].sort()) !== canonicalAttribution(support.evidence)) throw new PendingActivation('attribution proof does not resolve this exact participation, basis and citations');
      const fields: RelationAttributionProof['fields'] = {};
      for (const field of support.fields) {
        const expected = field === 'creditedName' ? participation.creditedName
          : (participation as AttributedParticipation).sourceIdentity?.[field];
        if (!Object.hasOwn(proof.fields, field) || canonicalAttribution(proof.fields[field]) !== canonicalAttribution(expected)) {
          throw new SemanticChangeRejected('unavailable-reference', 'a referenced attribution is unavailable');
        }
        fields[field] = structuredClone(expected);
      }
      // A batch owner may know more than this command requested. Its other fields
      // are neither sealed into this occurrence nor disclosed through this proof.
      return { basis: structuredClone(support.basis), receipt: proof.receipt, revision: proof.revision,
        validationToken: proof.validationToken, state: proof.state, fields,
        evidence: [...support.evidence], participant: structuredClone(participation.participant) };
    });
    return { proofs, guard: verified.guard };
  };
}
