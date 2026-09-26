import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry }
  from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { compositionReceiptIri, readCompositionReceipt,
  sealStructureAdmissionCancellation, terminalResult } from '../structure/change.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';

const definitions = {
  zone: { profile: 'zone-capability-v1', action: 'zone.edit', type: 'Zone',
    revisionType: 'ZoneRevision', head: 'zoneHead', operation: 'ZoneCreate' },
  collection: { profile: 'collection-curation-v1', action: 'collection.edit', type: 'Collection',
    revisionType: 'CollectionRevision', head: 'collectionHead', operation: 'CollectionCreate' },
} as const;

export interface OwnerCreateInput {
  kind: keyof typeof definitions;
  owner: string;
  actingSubject: string;
  idempotencyKey: string;
  requestDigest: string;
  space?: string;
  disclosure: 'public' | 'private';
  name?: string;
}

/** One receipt-proven owner half of the recoverable Structure bootstrap. */
export async function createAdmittedOwner(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: OwnerCreateInput) {
  const def = definitions[input.kind];
  const profile = `https://rezics.com/definition/${def.profile}`;
  const scope = `${input.kind}:edit:${input.owner}`;
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [`${input.kind}:edit`]);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: def.action, idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest });
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, input.requestDigest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
    }
  }
  if (admission.state !== 'sealed' && (!admission.dispatchEligible || admission.state === 'registered')) {
    await sealStructureAdmissionCancellation(env, admission);
  } else if (admission.state !== 'sealed') {
    const existing = await readCompositionReceipt(env, admission.id, def.action);
    if (!existing) {
      const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
      const operation = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
      const manifest = prepareComponent(env.objectDirectory, input.owner, {
        kind: input.kind, owner: input.owner, actingSubject: input.actingSubject,
        space: input.space, disclosure: input.disclosure, name: input.name }, profile);
      const receipt = compositionReceiptIri(admission.id, def.action);
      const batch = `urn:rezics:outbox:${hash(receipt)}`;
      const event = `urn:rezics:event:${hash(operation)}`;
      const disclosure = input.disclosure === 'public' ? 'Public' : 'Private';
      const ownerTriples = input.kind === 'zone'
        ? `${iri(input.owner)} a rv:Zone ; rv:space ${iri(input.space!)} ; rv:zoneState rv:Active ;
          rv:zoneHead ${iri(revision)} ; rv:disclosure rv:${disclosure} .
          ${iri(input.space!)} rv:zoneCapability ${iri(input.owner)} .`
        : `${iri(input.owner)} a rv:Collection ; rv:curator ${iri(input.actingSubject)} ;
          rv:disclosure rv:${disclosure} ; rv:collectionState rv:Active ;
          rv:collectionKind rv:StaticCollection ; rv:collectionHead ${iri(revision)} ;
          <https://schema.org/name> ${lit(input.name!)}@en .`;
      const prerequisite = input.kind === 'zone'
        ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.space!)} a rv:Space ;
            rv:owner ${iri(input.actingSubject)} ; rv:realmCapability ?realm .
            ?realm a rv:Realm ; rv:realmState rv:Active . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
            ${iri(input.space!)} rv:zoneCapability ?priorZone . } }`
        : '';
      const update = `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${ownerTriples} }
          GRAPH ${iri(GRAPHS.revisions)} {
            ${iri(revision)} a rv:${def.revisionType}, rv:RevisionAnchor ;
              rv:component ${iri(input.owner)} ; rv:operation ${iri(operation)} ;
              rv:${input.kind}Operation rv:${def.operation} ;
              rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
              rv:modelRevision ${iri(profile)} ; rv:shapeRevision ${iri(profile)} ;
              rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next .
          }
          GRAPH ${iri(GRAPHS.receipts)} {
            ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
              rv:requestDigest ${lit(input.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
              rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(scope)} ;
              rv:outcome rv:Succeeded ; rv:structureOwner ${iri(input.owner)} ;
              rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next .
          }
          GRAPH ${iri(GRAPHS.outbox)} {
            ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
              rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
            ${iri(event)} a rv:${def.operation}Event ; rv:ordinal 0 ;
              rv:action ${lit(def.action)} ; rv:receipt ${iri(receipt)} ;
              rv:operation ${iri(operation)} .
          }
        }
        WHERE {
          GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
            rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.owner)} ?p ?o } }
          ${prerequisite}
          BIND(?n + 1 AS ?next)
        }`;
      const validations = await profileValidations(env.fuseki, def.profile, [{
        shape: `${profile}/revision-shape`, focus: [revision],
        graphs: [GRAPHS.current, GRAPHS.revisions],
      }]);
      try { await validatedCommand(env, { receipt, digest: input.requestDigest,
        update, validations, deadlineMs: 10_000 }, admission); }
      catch { /* A lost graph response is resolved by the durable receipt below. */ }
    }
  }
  const terminal = await readCompositionReceipt(env, registered.id, def.action);
  if (!terminal) throw new PendingActivation(`${input.kind} owner outcome is unknown`);
  await access.recordGraphOutcome(registered.id, terminal);
  terminalResult(terminal, registered);
  if (terminal.owner !== input.owner || terminal.requestDigest !== input.requestDigest) {
    throw new IdempotencyConflict(`${input.kind} owner receipt differs from its bootstrap request`);
  }
  return { owner: input.owner, receipt: terminal.receipt,
    requestDigest: input.requestDigest, outcome: 'succeeded' as const };
}
