import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, finalizeInvalidProfile } from '../../infrastructure/invalid-receipt.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readRealmPolicy } from '../space/policy.ts';
import { discloseInventory, hasDisclosure, DisclosureUnavailable } from '../disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, CancelledActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';

import { CLASSIFICATION_CONTEXT_PROFILE, GLOBAL_CLASSIFICATION_CONTEXT,
  CLASSIFICATION_ISOLATE_POLICY, ensureGlobalClassificationContext } from './global.ts';
export { CLASSIFICATION_CONTEXT_PROFILE, GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from './global.ts';
export const CLASSIFICATION_INHERIT_POLICY = 'https://rezics.com/definition/classification-inherit-global-v1';
export const CLASSIFICATION_CONTEXT_V2_PROFILE = 'https://rezics.com/definition/classification-context-v2';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export class InvalidClassificationContextInput extends Error {}
export class ClassificationRealmUnavailable extends Error {}
export class ClassificationSchemeUnavailable extends Error {}
export class StaleClassificationContext extends Error {}

export type CreateClassificationContextInput = {
  realm: string;
  actingSubject: string;
} & ({ profile?: 'classification-context-v1' } | {
  profile: 'classification-context-v2';
  expectedHead: string | null;
  scheme: { id: string; expectedHead: string } | null;
});

export interface ClassificationContextReceipt {
  outcome: 'succeeded' | 'cancelled';
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
  context?: string;
  realm?: string;
  revision?: string;
  scheme?: string | null;
  reason?: 'stale-head' | 'scheme-unavailable';
}

export function classificationContextDigest(input: CreateClassificationContextInput): string {
  if (!nativeId.test(input.realm) || !nativeId.test(input.actingSubject)
    || input.profile !== undefined && !['classification-context-v1', 'classification-context-v2'].includes(input.profile)) {
    throw new InvalidClassificationContextInput('invalid classification context request');
  }
  if (input.profile === 'classification-context-v2') {
    if ((input.expectedHead !== null && !nativeId.test(input.expectedHead))
      || input.scheme !== null && (!input.scheme || !nativeId.test(input.scheme.id)
        || !nativeId.test(input.scheme.expectedHead))) {
      throw new InvalidClassificationContextInput('invalid classification context selection');
    }
    return hash(JSON.stringify({ family: input.profile, realm: input.realm,
      actingSubject: input.actingSubject, expectedHead: input.expectedHead,
      scheme: input.scheme && { id: input.scheme.id, expectedHead: input.scheme.expectedHead },
      global: GLOBAL_CLASSIFICATION_CONTEXT, inheritancePolicy: CLASSIFICATION_INHERIT_POLICY }));
  }
  return hash(JSON.stringify({ family: 'classification-context-v1', realm: input.realm,
    actingSubject: input.actingSubject, global: GLOBAL_CLASSIFICATION_CONTEXT,
    inheritancePolicy: CLASSIFICATION_INHERIT_POLICY }));
}

export function classificationContextReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0classification-context-create`)}`;
}

export async function readClassificationContextReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<ClassificationContextReceipt | null> {
  const receipt = classificationContextReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?digest ?id ?epoch ?scope ?dataEpoch ?sequence ?context ?realm ?revision ?scheme ?reason WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:classificationContext ?context ; rv:realm ?realm ;
        rv:contextRevision ?revision }
      OPTIONAL { ${iri(receipt)} rv:classificationScheme ?scheme }
      OPTIONAL { ${iri(receipt)} rv:reason ?reason }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id') || !value('epoch')
    || !value('scope') || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (outcome === 'succeeded' && (!value('context') || !value('realm') || !value('revision')))
    || (outcome === 'cancelled' && (value('context') || value('realm') || value('revision') || value('scheme')))
    || value('reason') !== undefined && !['stale-head', 'scheme-unavailable'].includes(value('reason')!)
    || outcome === 'succeeded' && value('reason') !== undefined) {
    throw new Error('classification context receipt is incomplete');
  }
  return { outcome, receipt, admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!,
    dataEpoch: value('dataEpoch')!, sequence: value('sequence')!,
    ...(outcome === 'succeeded' ? { context: value('context'), realm: value('realm'),
      revision: value('revision'), scheme: value('scheme') ?? null } : {}),
    ...(value('reason') ? { reason: value('reason') as ClassificationContextReceipt['reason'] } : {}) };
}

function checked(receipt: ClassificationContextReceipt, admission: RegisteredAdmission,
  input: CreateClassificationContextInput, digest: string): ClassificationContextReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('classification context admission differs from receipt');
  }
  if (receipt.reason === 'stale-head') throw new StaleClassificationContext('Expected Context or scheme head is stale');
  if (receipt.reason === 'scheme-unavailable') throw new ClassificationSchemeUnavailable('Classification scheme is unavailable');
  if (receipt.outcome === 'cancelled') throw new CancelledActivation('classification context creation was cancelled');
  if (receipt.realm !== input.realm) throw new IdempotencyConflict('classification Realm differs');
  return receipt;
}

async function validateCandidate(env: WorkActivationEnvironment, realm: string,
  context: string, selection = false): Promise<CommandValidation[]> {
  iri(realm); iri(context);
  const validations = await profileValidations(env.fuseki, 'classification-context-v1', [
    { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/global-shape`, focus: [GLOBAL_CLASSIFICATION_CONTEXT], graphs: [GRAPHS.current] },
    { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/realm-shape`, focus: [realm], graphs: [GRAPHS.current] },
    { shape: `${CLASSIFICATION_CONTEXT_PROFILE}/context-shape`, focus: [context], graphs: [GRAPHS.current] },
  ], { realm, context });
  if (selection) validations.push(...await profileValidations(env.fuseki, 'classification-context-v2', [
    { shape: `${CLASSIFICATION_CONTEXT_V2_PROFILE}/global-shape`, focus: [GLOBAL_CLASSIFICATION_CONTEXT], graphs: [GRAPHS.current] },
    { shape: `${CLASSIFICATION_CONTEXT_V2_PROFILE}/realm-shape`, focus: [realm], graphs: [GRAPHS.current] },
    { shape: `${CLASSIFICATION_CONTEXT_V2_PROFILE}/context-shape`, focus: [context], graphs: [GRAPHS.current] },
  ], { realm, context }));
  return validations;
}

/** One Context-keyed owner lookup, shared by configuration and its public read. */
export async function readRealmClassificationContext(env: WorkActivationEnvironment, realm: string) {
  if (!nativeId.test(realm)) throw new InvalidClassificationContextInput('invalid Realm identity');
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?revision ?scheme WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
      ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ; rv:classificationContext ?context .
      ?context a rv:ClassificationContext ; rv:realm ${iri(realm)} ; rv:contextRole rv:RealmClassification ;
        rv:contextState rv:Active ; rv:head ?revision ; rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
        rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} .
      ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ;
        rv:contextState rv:Active ; rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
      FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?other }
      OPTIONAL { ?context rv:classificationScheme ?scheme }
    }
  } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1 || !rows[0]?.context?.value || !rows[0].revision?.value)
    throw new PendingActivation('Classification context is incomplete or ambiguous');
  const policy = await readRealmPolicy(env, realm);
  if (!policy || policy.visibility === 'private') return null;
  return { realm, context: rows[0].context.value, contextRevision: rows[0].revision.value,
    role: 'realm-classification' as const, fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT,
    inheritancePolicy: CLASSIFICATION_INHERIT_POLICY, scheme: rows[0].scheme?.value ?? null };
}

/** Public metadata consumes the live Realm record, including Access closure.
 * The configuration/restore owner lookup above does not establish disclosure. */
export async function readPublicRealmClassificationContext(env: WorkActivationEnvironment, realm: string) {
  if (!nativeId.test(realm)) throw new InvalidClassificationContextInput('invalid Realm identity');
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  if (!hasDisclosure(env)) throw new DisclosureUnavailable('Realm disclosure is unavailable');
  const visible = async () => {
    const decisions = await discloseInventory(env, [{ owner: 'graph', resource: realm,
      component: 'record' }], ANONYMOUS_VIEWER, 'read');
    if (decisions.length !== 1) throw new DisclosureUnavailable('Realm disclosure is incomplete');
    return decisions[0] === 'visible';
  };
  if (!await visible()) return null;
  const context = await readRealmClassificationContext(env, realm);
  return await visible() ? context : null;
}

async function assertSelectedScheme(env: WorkActivationEnvironment,
  scheme: { id: string; expectedHead: string } | null) {
  if (!scheme) return;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(scheme.id)} a skos:ConceptScheme ; rv:schemeState rv:Active ; rv:schemeRevisionHead ?head .
      FILTER NOT EXISTS { ${iri(scheme.id)} rv:schemeState rv:Retired }
    } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (!rows.length) throw new ClassificationSchemeUnavailable('Classification scheme is unavailable');
  if (rows.length !== 1 || rows[0]?.head?.value !== scheme.expectedHead)
    throw new StaleClassificationContext('Expected scheme head is stale');
}

/** Provision an explicit role-specific context for one active public Realm. */
export async function createClassificationContext(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: CreateClassificationContextInput,
): Promise<ClassificationContextReceipt> {
  const digest = classificationContextDigest(input);
  if (admission.action !== 'classification.context.configure'
    || admission.scope !== `classification:context:${input.realm}`
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('classification context admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, classificationContextReceiptIri(admission.id));
  const existing = await readClassificationContextReceipt(env, admission.id);
  if (existing) return checked(existing, admission, input, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('classification context admission expired');
  }
  const realmCheck = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ; rv:disclosure rv:Public .
    ${iri(input.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
    OPTIONAL { ${iri(input.realm)} rv:classificationContext ?context .
      OPTIONAL { ?context a rv:ClassificationContext ; rv:realm ${iri(input.realm)} ;
        rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ; rv:head ?head . } }
  } } LIMIT 2`, 8192);
  const realms = realmCheck.results?.bindings ?? [];
  if (realms.length !== 1) throw new ClassificationRealmUnavailable('Realm is unavailable or ambiguous');
  const prior = realms[0]!;
  const selection = input.profile === 'classification-context-v2';
  const expectedHead = selection ? input.expectedHead : null;
  const scheme = selection ? input.scheme : null;
  if (selection && (expectedHead === null ? prior.context !== undefined : prior.head?.value !== expectedHead))
    throw new StaleClassificationContext('Expected Context head is stale');
  if (!selection && prior.context) throw new ClassificationRealmUnavailable('Realm classification context is already configured');
  await assertSelectedScheme(env, scheme);
  await ensureGlobalClassificationContext(env);
  const context = expectedHead ? prior.context!.value : ID + Bun.randomUUIDv7();
  const profile = selection ? CLASSIFICATION_CONTEXT_V2_PROFILE : CLASSIFICATION_CONTEXT_PROFILE;
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await validateCandidate(env, input.realm, context, selection);
  const manifest = prepareComponent(env.objectDirectory, context,
    { realm: input.realm, role: 'realm-classification', state: 'active',
      fallbackContext: GLOBAL_CLASSIFICATION_CONTEXT,
      inheritancePolicy: CLASSIFICATION_INHERIT_POLICY,
      ...(selection ? { scheme: scheme?.id ?? null, selectionIntent: { expectedHead,
        scheme: scheme ? { id: scheme.id, expectedHead: scheme.expectedHead } : null } } : {}) }, profile);
  if (Date.parse(admission.expiresAt) <= Date.now()) {
    throw new PendingActivation('classification context admission expired');
  }
  const receipt = classificationContextReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try {
    const result = await env.fuseki.commandWithReceipt({ receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      ${expectedHead ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(context)} rv:head ${iri(expectedHead)} ; rv:classificationScheme ?oldScheme ; rv:definitionProfile ?oldProfile .
      }` : ''}
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.realm)} rv:classificationContext ${iri(context)} .
        ${iri(context)} a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
          rv:contextState rv:Active ; rv:realm ${iri(input.realm)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ; rv:head ${iri(revision)} .
        ${selection ? `${iri(context)} rv:definitionProfile ${iri(profile)} .` : ''}
        ${scheme ? `${iri(context)} rv:classificationScheme ${iri(scheme.id)} .` : ''}
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(context)} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(profile)} ; rv:shapeRevision ${iri(profile)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
        ${expectedHead ? `${iri(revision)} rv:predecessor ${iri(expectedHead)} .` : ''}
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
          rv:classificationContext ${iri(context)} ; rv:realm ${iri(input.realm)} ;
          rv:contextRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${selection ? `${iri(receipt)} rv:commandFamily "classification-context-v2" ;
          rv:action "classification.context.configure" .` : ''}
        ${expectedHead ? `${iri(receipt)} rv:expectedHead ${iri(expectedHead)} .` : ''}
        ${scheme ? `${iri(receipt)} rv:classificationScheme ${iri(scheme.id)} .` : ''}
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ClassificationContextCreatedEvent ; rv:ordinal 0 ;
          rv:action "classification.context.configure" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} ; rv:realm ${iri(input.realm)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ?space a rv:Space ; rv:realmCapability ${iri(input.realm)} ; rv:disclosure rv:Public .
        ${iri(input.realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active .
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      ${expectedHead ? `GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.realm)} rv:classificationContext ${iri(context)} .
        ${iri(context)} a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
          rv:contextState rv:Active ; rv:realm ${iri(input.realm)} ; rv:head ${iri(expectedHead)} ;
          rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} .
        OPTIONAL { ${iri(context)} rv:classificationScheme ?oldScheme }
        OPTIONAL { ${iri(context)} rv:definitionProfile ?oldProfile }
      }` : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(input.realm)} rv:classificationContext ?oldContext } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(context)} ?p ?o } }`}
      ${scheme ? `GRAPH ${iri(GRAPHS.current)} { ${iri(scheme.id)} a skos:ConceptScheme ;
        rv:schemeState rv:Active ; rv:schemeRevisionHead ${iri(scheme.expectedHead)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(scheme.id)} rv:schemeState rv:Retired } }` : ''}
      GRAPH ${iri(GRAPHS.current)} {
          ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
            rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
            rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm } }
      BIND(?n + 1 AS ?next)
    }` });
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      // A competing replacement can invalidate the native prestate before its
      // guarded update. Seal the domain refusal so an idempotent replay agrees.
      if (selection) {
        await assertSelectedScheme(env, scheme);
        const current = await readRealmClassificationContext(env, input.realm);
        if (expectedHead === null ? current !== null : current?.contextRevision !== expectedHead)
          throw new StaleClassificationContext('Expected Context head is stale');
      }
      if (await finalizeInvalidProfile(env.fuseki, env.lineage, receipt, digest, admission) === 'rejected')
        throw new InvalidClassificationContextInput(`Classification context validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidClassificationContextInput || error instanceof CommandRejected
      || error instanceof StaleClassificationContext || error instanceof ClassificationSchemeUnavailable) throw error;
    updateError = error;
  }
  const committed = await readClassificationContextReceipt(env, admission.id);
  if (committed) return checked(committed, admission, input, digest);
  if (selection && !updateError) {
    await assertSelectedScheme(env, scheme);
    const current = await readRealmClassificationContext(env, input.realm);
    if (expectedHead === null ? current !== null : current?.contextRevision !== expectedHead)
      throw new StaleClassificationContext('Expected Context head is stale');
  }
  const occupied = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.realm)} rv:classificationContext ?context }
  }`);
  if (!selection && occupied.boolean === true) {
    throw new ClassificationRealmUnavailable('Realm classification context is already configured');
  }
  throw new PendingActivation(updateError
    ? 'classification context update outcome unknown' : 'classification context guard did not match');
}

/** Terminal receipt for a context admission closed before dispatch. */
export async function sealClassificationContextAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, reason?: ClassificationContextReceipt['reason']): Promise<ClassificationContextReceipt> {
  if (admission.action !== 'classification.context.configure'
    || !admission.scope.startsWith('classification:context:')) {
    throw new IdempotencyConflict('unsupported classification context admission');
  }
  const existing = await readClassificationContextReceipt(env, admission.id);
  if (existing) return existing;
  const receipt = classificationContextReceiptIri(admission.id);
  const digest = hash(`${receipt}\0cancel`);
  const event = `urn:rezics:event:${digest}`;
  const batch = `urn:rezics:outbox:${digest}`;
  let updateError: unknown;
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    validations: [], deadlineMs: 10_000, update: `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(admission.requestDigest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Cancelled ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next .
        ${reason ? `${iri(receipt)} rv:reason ${lit(reason)} .` : ''}
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ClassificationContextCancelledEvent ; rv:ordinal 0 ;
          rv:action "classification.context.configure" ; rv:receipt ${iri(receipt)} ;
          rv:admissionId ${lit(admission.id)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }); } catch (error) { updateError = error; }
  const committed = await readClassificationContextReceipt(env, admission.id);
  if (!committed || committed.requestDigest !== admission.requestDigest
    || committed.admissionId !== admission.id
    || committed.authorityEpoch !== admission.authorityEpoch
    || committed.scope !== admission.scope) {
    throw new PendingActivation(updateError
      ? 'classification context cancellation outcome unknown' : 'classification context cancellation guard did not match');
  }
  return committed;
}
