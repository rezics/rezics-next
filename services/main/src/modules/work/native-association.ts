import { readExactDefinition } from '../relation/change.ts';
import { namePolicyPrincipal } from '../disclosure/viewer.ts';
import type { RelationAttributionProof } from '../relation/attribution.ts';
import { systemDisclosure } from '../target/disclosed-references.ts';
import { PROFILES } from '../semantic/schema.ts';
import type { RetainedStatementCoverage } from '../statement/v2-coverage.ts';
import { DATASET, GRAPHS, iri, lit } from './activate.ts';
import { readCreditOwnerHead, readCreditOwnerWitness } from './credit-verification.ts';
import { readNativeCreditAttributionProof } from './credit-attribution.ts';
import { canonicalCreditValue, creditNativeId, creditReceiptId, type CreditAttributionField } from './credit-association-state.ts';
import { readRetainedCreditAssociationHead, readSealedRetainedCreditAssociation } from './credit-association-read.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from './read-session.ts';

const equal = (left: unknown, right: unknown) => canonicalCreditValue(left) === canonicalCreditValue(right);
const unavailable = (message: string): never => { throw new WorkReadUnavailable(message); };

/** The native credit command and its own sealed allocations are authority for
 * this occurrence. External conversion activation is a different owner: it
 * neither admits these tuples nor certifies their Statement/adoption inventory. */
export async function readNativeCreditAssociation(session: WorkReadSession, occurrence: string, revision?: string) {
  const env = session.deps.environment;
  const original = await readCreditOwnerWitness(env, occurrence);
  if (!original) return null;
  const head = await readRetainedCreditAssociationHead(env, occurrence, original.value.work);
  if (!head) return unavailable('Native credit participation allocations are unavailable');
  if (revision && head !== revision) throw new WorkReadMoved('Native credit association head changed');
  const seal = await readSealedRetainedCreditAssociation(env, occurrence, head);
  const current = await readCreditOwnerHead(env, original);
  const { state } = seal, native = original.value;
  if (!current || current.creditHead !== state.creditRevision || native.revision !== state.creditRevision
    || original.profile !== state.retainedProfile || native.work !== state.work || native.expectedHead !== state.workRevision
    || native.role !== state.role || state.participations.length !== 2 || state.context !== 'global'
    || state.applicability.length || state.qualification !== 'asserted') {
    return unavailable('Native credit seal differs from its original tuple command');
  }
  const subject = state.participations.find(part => part.id === state.subjectParticipation);
  const work = state.participations.find(part => part.id === state.workParticipation);
  const participant = native.agent ? { kind: 'resource', ref: native.agent }
    : { kind: 'external', provider: native.provider, namespace: native.namespace, key: native.sourceKey };
  if (!subject || !work || !equal(subject.participant, participant)
    || subject.position !== (native.agent ? undefined : native.nativeOrdinal)
    || !equal(work.participant, { kind: 'resource', ref: native.work })) {
    return unavailable('Native credit participation differs from its original tuple');
  }
  if (seal.sourcePosition.dataEpoch !== session.position.dataEpoch
    || original.receipt.dataEpoch !== session.position.dataEpoch
    || BigInt(seal.sourcePosition.sequence) > BigInt(session.position.sequence)
    || BigInt(original.receipt.sequence) > BigInt(session.position.sequence)) {
    throw new WorkReadMoved('Native credit source position changed');
  }
  const definition = await readExactDefinition(env, state.mapping.revision, systemDisclosure);
  const binding = definition?.association, mapping = definition?.retainedCredit;
  if (!definition || definition.modelRevision !== PROFILES.definitionV2 || definition.lifecycle !== 'active'
    || !binding || binding.kind !== 'credit' || !mapping || definition.definition !== state.mapping.definition
    || mapping.origin !== state.retainedProfile || mapping.storedRole !== state.role
    || `${definition.definition}/role/${binding.workRole}` !== state.mapping.workRole
    || `${definition.definition}/role/${mapping.subjectRole}` !== state.mapping.subjectRole
    || !binding.subjectRoles.includes(mapping.subjectRole)
    || !equal(mapping.externalNamespace ?? null, state.mapping.externalNamespace)
    || work.role !== state.mapping.workRole || subject.role !== state.mapping.subjectRole) {
    return unavailable('Native credit exact authored Definition mapping is unavailable');
  }
  // This guard carries only facts already resolved by their actual native
  // owners. It grants neither adoption nor external Source attribution.
  const guard = `GRAPH ${iri(GRAPHS.current)} {
      ${iri(occurrence)} rv:creditRevision ${iri(native.revision)} ; rv:associationHead ${iri(head)} ; rv:work ${iri(native.work)} .
      ${iri(native.work)} a <https://schema.org/CreativeWork> ; rv:head ${iri(current.workHead)} .
      FILTER NOT EXISTS { ${iri(occurrence)} rv:retiredBy ?nativeCreditRetired }
      FILTER NOT EXISTS { ${iri(occurrence)} rv:protectionHead ?nativeCreditProtected } }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} a rv:RetainedCreditAssociationRevision ;
      rv:component ${iri(occurrence)} ; rv:manifest ${iri(seal.manifest)} ;
      rv:participation ${iri(state.workParticipation)}, ${iri(state.subjectParticipation)} }
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(seal.receipt)} rv:outcome rv:Succeeded ;
      rv:component ${iri(occurrence)} ; rv:revision ${iri(head)} ; rv:operation ${iri(seal.operation)} }
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?nativeCreditSequence .
      FILTER(STR(?nativeCreditSequence) = ${lit(session.position.sequence)})
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }`;
  return { ...seal, occurrence, revision: head, definition, original, current, guard };
}

/** Exact native identity seam for the existing Statement coverage validator.
 * DecisionSlots, occurrence adoption, full Participant and disclosure are still
 * resolved by that validator; this is not a completed coverage attestation. */
export async function nativeCreditStatementCoverage(session: WorkReadSession, occurrence: string,
  revision: string): Promise<RetainedStatementCoverage | null> {
  const native = await readNativeCreditAssociation(session, occurrence, revision);
  if (!native) return null;
  const value: RetainedStatementCoverage = { occurrence, revision, definition: native.definition, guard: native.guard,
    state: { definition: native.state.mapping.revision, applicability: [...native.state.applicability],
      participations: native.state.participations.map(({ id: iri, ...part }) => ({ ...part, iri })) },
    native: { receipt: native.receipt, manifest: native.manifest, modelGeneration: native.modelGeneration,
      attribution: { original: native.original.receipt, seal: native.receipt } } };
  session.observeDependency(`native-credit-coverage:${occurrence}:${revision}`, value,
    () => nativeCreditStatementCoverage(session, occurrence, revision));
  return value;
}

/** Optional source fields require the current existing attribution owner, in
 * addition to the native identity seal. Withdrawal removes only those fields;
 * absent or malformed proof is unavailable rather than an invented withdrawal. */
export async function readNativeCreditAttribution(session: WorkReadSession,
  native: NonNullable<Awaited<ReturnType<typeof readNativeCreditAssociation>>>, requestedActor?: string) {
  const participations = native.state.participations.map(({ id: _id, ...part }) => part);
  const requests = participations.flatMap(participation => participation.attributionSupports.map(support => ({ participation, support })));
  const empty = native.state.participations.map(part => ({ participation: part.id, currentFields: [] as CreditAttributionField[] }));
  if (!requests.length) return empty;
  const owner = session.deps.relationAttribution, principal = session.principal ?? namePolicyPrincipal(session.viewer);
  const actingSubject = session.options.actingSubject ?? requestedActor;
  const external = requests.filter(request => request.support.basis.kind !== 'native-credit' || request.support.evidence.length);
  if (external.length && (!owner || !principal || !actingSubject)) return unavailable('Native credit exact attribution owner is unavailable');
  const read = async () => {
    session.checkDeadline();
    const attributed = external.length ? await owner!.verify({ principal: principal!, actingSubject: actingSubject!,
      definition: native.definition, participations, requests: external }) : null;
    if (external.length && (!attributed || !attributed.guard.trim() || attributed.proofs.length !== external.length)) {
      return unavailable('Native credit exact attribution proof is unavailable');
    }
    const proofs: RelationAttributionProof[] = [], guards: string[] = [];
    for (const request of requests) {
      const index = external.indexOf(request);
      if (index !== -1) proofs.push(attributed!.proofs[index]!);
      else {
        const proof = await readNativeCreditAttributionProof(session.deps.environment, native.definition, participations, request);
        if (!proof) return unavailable('Native credit original attribution witness is unavailable');
        proofs.push(proof.proof); guards.push(proof.guard);
      }
    }
    const result = { proofs, guard: [...guards, ...(attributed ? [attributed.guard] : [])].join('\n') };
    session.checkDeadline();
    if (!result.guard.trim() || result.proofs.length !== requests.length) {
      return unavailable('Native credit exact attribution proof is unavailable');
    }
    const current = empty.map(part => ({ ...part, currentFields: [...part.currentFields] }));
    for (const [index, proof] of result.proofs.entries()) {
      const { participation, support } = requests[index]!;
      if (!['current', 'withdrawn'].includes(proof.state) || !creditReceiptId(proof.receipt)
        || !creditNativeId(proof.revision) || !/^[0-9a-f]{64}$/.test(proof.validationToken)
        || !proof.fields || typeof proof.fields !== 'object' || Array.isArray(proof.fields) || !Array.isArray(proof.evidence)
        || !equal(proof.basis, support.basis) || !equal(proof.participant, participation.participant)
        || !equal([...proof.evidence].sort(), [...support.evidence].sort())) {
        return unavailable('Native credit attribution differs from its exact supported participation');
      }
      const allocation = native.state.participations.find(part => part.role === participation.role
        && equal(part.participant, participation.participant));
      const fields = current.find(part => part.participation === allocation?.id)?.currentFields;
      if (!fields) return unavailable('Native credit attribution allocation is unavailable');
      for (const field of support.fields) {
        const expected = field === 'creditedName' ? participation.creditedName : participation.sourceIdentity?.[field];
        if (!Object.hasOwn(proof.fields, field) || !equal(proof.fields[field], expected)) {
          return unavailable('Native credit attribution differs from its exact supported field');
        }
        if (proof.state === 'current' && !fields.includes(field)) fields.push(field);
      }
    }
    return { attribution: current.map(part => ({ ...part, currentFields: part.currentFields.sort() })), proof: result };
  };
  const result = await read();
  session.observeDependency(`native-credit-attribution:${native.occurrence}:${native.revision}`, result, read);
  return result.attribution;
}
