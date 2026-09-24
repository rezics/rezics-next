import { CommandRejected, type CommandValidation } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, CancelledActivation,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from './context.ts';

export const CLASSIFICATION_PROPOSITION_PROFILE = 'https://rezics.com/definition/classification-proposition-v1';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const labelPattern = /^[^\u0000-\u001f\u007f]{1,120}$/u;
export class InvalidClassificationPropositionInput extends Error {}
export class ClassificationDefinitionUnavailable extends Error {}

export interface CreateClassificationPropositionInput {
  label: string;
  actingSubject: string;
}

export interface PropositionDefinitions {
  scheme: string; concept: string; path: string; expression: string; sense: string;
}
export interface ClassificationPropositionReceipt {
  outcome: 'succeeded' | 'cancelled';
  receipt: string; admissionId: string; requestDigest: string; authorityEpoch: string;
  scope: string; dataEpoch: string; sequence: string;
  definitions?: PropositionDefinitions;
  revision?: string;
}

export function classificationPropositionDigest(input: CreateClassificationPropositionInput): string {
  if (!nativeId.test(input.actingSubject) || !labelPattern.test(input.label)
    || input.label.trim() !== input.label) {
    throw new InvalidClassificationPropositionInput('invalid classification proposition request');
  }
  return hash(JSON.stringify({ family: 'classification-proposition-v1', label: input.label,
    actingSubject: input.actingSubject, scope: GLOBAL_CLASSIFICATION_CONTEXT }));
}

export function classificationPropositionReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0classification-proposition-create`)}`;
}

export async function readClassificationPropositionReceipt(env: WorkActivationEnvironment,
  admissionId: string): Promise<ClassificationPropositionReceipt | null> {
  const receipt = classificationPropositionReceiptIri(admissionId);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?outcome ?digest ?id ?epoch ?scope ?dataEpoch ?sequence ?scheme ?concept ?path ?expression ?sense ?revision WHERE {
    GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ; rv:admissionId ?id ; rv:authorityEpoch ?epoch ;
        rv:admittedScope ?scope ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:scheme ?scheme ; rv:concept ?concept ; rv:path ?path ;
        rv:expression ?expression ; rv:sense ?sense ; rv:definitionRevision ?revision }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const value = (name: string) => row[name]?.value;
  const outcome = value('outcome') === `${RV}Succeeded` ? 'succeeded'
    : value('outcome') === `${RV}Cancelled` ? 'cancelled' : null;
  const refs = ['scheme', 'concept', 'path', 'expression', 'sense', 'revision'];
  if (rows.length !== 1 || !outcome || !value('digest') || !value('id') || !value('epoch')
    || !value('scope') || !value('dataEpoch') || !/^[0-9]+$/.test(value('sequence') ?? '')
    || (outcome === 'succeeded' && refs.some((name) => !value(name)))
    || (outcome === 'cancelled' && refs.some((name) => value(name)))) {
    throw new Error('classification proposition receipt is incomplete');
  }
  return { outcome, receipt, admissionId: value('id')!, requestDigest: value('digest')!,
    authorityEpoch: value('epoch')!, scope: value('scope')!, dataEpoch: value('dataEpoch')!,
    sequence: value('sequence')!, ...(outcome === 'succeeded' ? {
      definitions: { scheme: value('scheme')!, concept: value('concept')!,
        path: value('path')!, expression: value('expression')!, sense: value('sense')! },
      revision: value('revision')! } : {}) };
}

function checked(receipt: ClassificationPropositionReceipt, admission: RegisteredAdmission,
  digest: string): ClassificationPropositionReceipt {
  if (receipt.admissionId !== admission.id || receipt.requestDigest !== digest
    || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope) {
    throw new IdempotencyConflict('classification proposition admission differs from receipt');
  }
  if (receipt.outcome === 'cancelled') throw new CancelledActivation('classification proposition creation was cancelled');
  return receipt;
}

async function validateCandidate(env: WorkActivationEnvironment, definitions: PropositionDefinitions,
  label: string): Promise<CommandValidation[]> {
  for (const value of Object.values(definitions)) iri(value);
  if (!labelPattern.test(label)) throw new InvalidClassificationPropositionInput('invalid label');
  return profileValidations(env.fuseki, 'classification-proposition-v1',
    (Object.entries(definitions) as [keyof PropositionDefinitions, string][]).map(([role, focus]) => ({
      shape: `${CLASSIFICATION_PROPOSITION_PROFILE}/${role}-shape`, focus: [focus],
      graphs: [GRAPHS.current],
    })));
}

/** Create five distinct definition identities as one exact immutable component. */
export async function createClassificationProposition(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, input: CreateClassificationPropositionInput,
): Promise<ClassificationPropositionReceipt> {
  const digest = classificationPropositionDigest(input);
  if (admission.action !== 'classification.proposition.define'
    || admission.scope !== 'classification:define:global'
    || admission.actingSubject !== input.actingSubject || admission.requestDigest !== digest) {
    throw new IdempotencyConflict('classification proposition admission differs from intent');
  }
  await assertNotInvalidProfileReceipt(env.fuseki, classificationPropositionReceiptIri(admission.id));
  const existing = await readClassificationPropositionReceipt(env, admission.id);
  if (existing) return checked(existing, admission, digest);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('admission expired');
  const global = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
      rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
      rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
    FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?realm }
    FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback }
  } }`);
  if (global.boolean !== true) throw new ClassificationDefinitionUnavailable('Global classification context is unavailable');
  const definitions: PropositionDefinitions = { scheme: ID + Bun.randomUUIDv7(),
    concept: ID + Bun.randomUUIDv7(), path: ID + Bun.randomUUIDv7(),
    expression: ID + Bun.randomUUIDv7(), sense: ID + Bun.randomUUIDv7() };
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const validations = await validateCandidate(env, definitions, input.label);
  const manifest = prepareComponent(env.objectDirectory, definitions.sense,
    { ...definitions, label: input.label, language: 'en', scope: GLOBAL_CLASSIFICATION_CONTEXT,
      profile: CLASSIFICATION_PROPOSITION_PROFILE }, CLASSIFICATION_PROPOSITION_PROFILE);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('admission expired');
  const receipt = classificationPropositionReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  let updateError: unknown;
  try {
    const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}> PREFIX skos: <${SKOS}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(definitions.scheme)} a skos:ConceptScheme ; rv:schemeState rv:Active .
        ${iri(definitions.concept)} a skos:Concept ; skos:inScheme ${iri(definitions.scheme)} ;
          skos:prefLabel ${lit(input.label)}@en ; rv:conceptState rv:Active .
        ${iri(definitions.path)} a rv:ConceptPath ; rv:pathKind rv:SingleConcept ;
          rv:pathLength 1 ; rv:terminalConcept ${iri(definitions.concept)} ; rv:pathState rv:Active .
        ${iri(definitions.expression)} a rv:ClassificationExpression ;
          rv:path ${iri(definitions.path)} ; rv:propositionKind rv:ConceptAssertion ;
          rv:assertedConcept ${iri(definitions.concept)} ; rv:expressionState rv:Active .
        ${iri(definitions.sense)} a rv:ClassificationSense ; rv:path ${iri(definitions.path)} ;
          rv:expression ${iri(definitions.expression)} ;
          rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:senseState rv:Active ; rv:head ${iri(revision)} .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(definitions.sense)} ;
          rv:operation ${iri(operation)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
          rv:shapeRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
          rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
          rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
          rv:outcome rv:Succeeded ; rv:scheme ${iri(definitions.scheme)} ;
          rv:concept ${iri(definitions.concept)} ; rv:path ${iri(definitions.path)} ;
          rv:expression ${iri(definitions.expression)} ; rv:sense ${iri(definitions.sense)} ;
          rv:definitionRevision ${iri(revision)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ClassificationPropositionDefinedEvent ; rv:ordinal 0 ;
          rv:action "classification.proposition.define" ; rv:receipt ${iri(receipt)} ;
          rv:operation ${iri(operation)} .
      }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?realm } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?fallback } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      ${Object.values(definitions).map((id) => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(id)} ?p ?o } }`).join('\n')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
    if (result.status === 'unknown-profile') throw new CommandRejected(result);
    if (result.status === 'invalid') {
      throw new InvalidClassificationPropositionInput(`Classification proposition validation ${result.status}`);
    }
  } catch (error) {
    if (error instanceof InvalidClassificationPropositionInput || error instanceof CommandRejected) throw error;
    updateError = error;
  }
  const committed = await readClassificationPropositionReceipt(env, admission.id);
  if (committed) return checked(committed, admission, digest);
  throw new PendingActivation(updateError ? 'classification definition update outcome unknown'
    : 'classification definition guard did not match');
}

export async function sealClassificationPropositionAdmission(env: WorkActivationEnvironment,
  admission: RegisteredAdmission): Promise<ClassificationPropositionReceipt> {
  if (admission.action !== 'classification.proposition.define'
    || admission.scope !== 'classification:define:global') {
    throw new IdempotencyConflict('unsupported classification definition admission');
  }
  const existing = await readClassificationPropositionReceipt(env, admission.id);
  if (existing) return existing;
  const receipt = classificationPropositionReceiptIri(admission.id);
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
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} {
        ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ClassificationPropositionCancelledEvent ; rv:ordinal 0 ;
          rv:action "classification.proposition.define" ; rv:receipt ${iri(receipt)} ;
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
  const committed = await readClassificationPropositionReceipt(env, admission.id);
  if (!committed || committed.requestDigest !== admission.requestDigest
    || committed.admissionId !== admission.id
    || committed.authorityEpoch !== admission.authorityEpoch
    || committed.scope !== admission.scope) {
    throw new PendingActivation(updateError ? 'definition cancellation outcome unknown'
      : 'definition cancellation guard did not match');
  }
  return committed;
}
