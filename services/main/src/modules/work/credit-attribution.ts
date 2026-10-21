import type { RelationAttributionOwner, RelationAttributionProof, RelationAttributionRequest } from '../relation/attribution.ts';
import { readExactDefinition, type ExactDefinition } from '../relation/change.ts';
import type { AttributedParticipation } from '../relation/v2-schema.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { GRAPHS, hash, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { canonicalCreditValue, creditNativeId, creditReceiptId } from './credit-association-state.ts';
import type { RetainedCreditAssociationReadOwners } from './credit-association-read.ts';
import { readCreditOwnerHead, readCreditOwnerWitness, type CreditOwnerWitness } from './credit-verification.ts';
import { unerased } from './public-patterns.ts';

const equal = (a: unknown, b: unknown) => canonicalCreditValue(a) === canonicalCreditValue(b);
export function creditOwnerParticipant(witness: CreditOwnerWitness) {
  const value = witness.value;
  return value.agent ? { kind: 'resource' as const, ref: value.agent }
    : { kind: 'external' as const, provider: value.provider!, namespace: value.namespace!, key: value.sourceKey };
}

/** Guard the actual original credit command and current native owner heads in
 * the same graph update as the compatibility view. No provider/name lookup. */
export function creditOwnerGuard(witness: CreditOwnerWitness, head: { workHead: string; creditHead: string }) {
  const { value, receipt } = witness;
  if (![value.credit, value.work, value.revision, head.workHead, head.creditHead].every(creditNativeId)
    || value.revision !== head.creditHead || !creditReceiptId(receipt.receipt)) throw new Error('invalid credit owner guard');
  return `GRAPH ${iri(GRAPHS.current)} {
    ${iri(value.work)} a <https://schema.org/CreativeWork> ; rv:head ${iri(head.workHead)} .
    ${iri(value.credit)} rv:work ${iri(value.work)} ; rv:creditRevision ${iri(head.creditHead)} .
    FILTER NOT EXISTS { ${iri(value.credit)} rv:creditRevision ?otherCreditHead . FILTER(?otherCreditHead != ${iri(head.creditHead)}) }
    FILTER NOT EXISTS { ${iri(value.work)} rv:head ?otherWorkHead . FILTER(?otherWorkHead != ${iri(head.workHead)}) }
    FILTER NOT EXISTS { ${iri(value.credit)} rv:retiredBy ?creditRetirement }
    FILTER NOT EXISTS { ${iri(value.credit)} rv:protectionHead ?creditProtection }
  }
  GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
    rv:creditRevision ${iri(value.revision)} ; rv:requestDigest ${lit(receipt.requestDigest)} . }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.revision)} a rv:ErasedRevision } }
  ${unerased(iri(value.work))}`;
}

/** Public native receipt proof. Reading an already admitted tuple grants no
 * command authority and needs no invented Account or acting Subject. The tuple
 * attests only its qualified provider/namespace/key, never Source aliases or
 * reported absence. Citation fields remain a separate owner operation. */
export async function readNativeCreditAttributionProof(env: WorkActivationEnvironment, definition: ExactDefinition,
  participations: readonly AttributedParticipation[], request: RelationAttributionRequest) {
  const { participation, support } = request;
  if (support.basis.kind !== 'native-credit') return null;
  const native = await readCreditOwnerWitness(env, support.basis.credit);
  const head = native && await readCreditOwnerHead(env, native);
  const mapping = definition.retainedCredit;
  const work = participations.find(item => definition.roleKeys[item.role] === definition.workSubjectRole);
  if (!native || !head || head.creditHead !== native.value.revision
    || native.value.revision !== support.basis.revision || !mapping
    || mapping.origin !== native.profile || mapping.storedRole !== native.value.role
    || definition.roleKeys[participation.role] !== mapping.subjectRole
    || work?.participant.kind !== 'resource' || work.participant.ref !== native.value.work
    || !equal(participation.participant, creditOwnerParticipant(native))
    || participation.position !== (native.value.agent ? undefined : native.value.nativeOrdinal)) return null;
  const proof: RelationAttributionProof = { basis: support.basis, receipt: native.receipt.receipt,
    revision: native.value.revision, validationToken: hash(canonicalCreditValue(native)), state: 'current', evidence: [],
    participant: creditOwnerParticipant(native), fields: native.value.agent ? {} : {
      provider: native.value.provider, namespace: native.value.namespace, key: native.value.sourceKey } };
  return { native, head, proof, guard: creditOwnerGuard(native, head) };
}

/** Compose native identity with the existing citation/field/rights owner.
 * Manual citations are verified by that owner independently of conversion.
 * The native command is never substituted for an external citation receipt. */
export function creditAttributionOwner(
  env: WorkActivationEnvironment,
  citations?: RelationAttributionOwner,
): RelationAttributionOwner {
  return { async verify(input) {
    const guards: string[] = [], proofs: RelationAttributionProof[] = [];
    for (const request of input.requests) {
      const { participation, support } = request;
      let native: CreditOwnerWitness | null = null;
      let nativeProof: RelationAttributionProof | null = null;
      if (support.basis.kind === 'native-credit') {
        const resolved = await readNativeCreditAttributionProof(env, input.definition, input.participations, request);
        if (!resolved) return null;
        native = resolved.native; nativeProof = resolved.proof;
        guards.push(resolved.guard);
      }
      let proof: RelationAttributionProof;
      if (native && !support.evidence.length) {
        proof = nativeProof!;
      } else {
        if (!citations) return null;
        const supported = await citations.verify({ ...input, requests: [request] });
        const supplied = supported?.proofs[0];
        if (!supported || supported.proofs.length !== 1 || !supported.guard.trim() || !supplied
          || (native && supplied.receipt === native.receipt.receipt)) return null;
        guards.push(supported.guard);
        proof = supplied;
      }
      if (!creditReceiptId(proof.receipt) || !creditNativeId(proof.revision)
        || !/^[0-9a-f]{64}$/.test(proof.validationToken) || !['current', 'withdrawn'].includes(proof.state)
        || !equal(proof.basis, support.basis) || !equal(proof.participant, participation.participant)
        || !equal([...proof.evidence].sort(), [...support.evidence].sort())) return null;
      const fields: RelationAttributionProof['fields'] = {};
      for (const field of support.fields) {
        const attributed = input.participations.find(item => equal(item, participation));
        const expected = field === 'creditedName' ? attributed?.creditedName : attributed?.sourceIdentity?.[field];
        if (!Object.hasOwn(proof.fields, field) || !equal(proof.fields[field], expected)) return null;
        fields[field] = structuredClone(expected);
      }
      proofs.push({ ...structuredClone(proof), fields });
    }
    return { proofs, guard: guards.join('\n') };
  } };
}

/** Read-side adapter for the same trusted owner. Withdrawal is retained as a
 * current validation result; the caller decides whether fields are supported. */
export function retainedCreditAttributionReader(
  env: WorkActivationEnvironment,
  owner: RelationAttributionOwner,
  actingSubject: string,
): NonNullable<RetainedCreditAssociationReadOwners['attribution']> {
  return async ({ principal, view, participation, support }) => {
    const definition = await readExactDefinition(env, view.mapping.revision, systemDisclosure);
    if (!definition || definition.definition !== view.mapping.definition) return null;
    const participations = view.participations.map(({ id: _id, ...item }) => item);
    const part = participations.find(item => item.role === participation.role && equal(item.participant, participation.participant));
    if (!part) return null;
    const result = await owner.verify({ principal, actingSubject, definition, participations,
      requests: [{ participation: part, support }] });
    const proof = result?.proofs[0];
    if (!result?.guard.trim() || result.proofs.length !== 1 || !proof) return null;
    // The composed owner has checked exact basis, participant, fields and citations.
    return { basis: proof.basis, state: proof.state, receipt: proof.receipt,
      validationToken: proof.validationToken, fields: proof.fields, evidence: proof.evidence };
  };
}
