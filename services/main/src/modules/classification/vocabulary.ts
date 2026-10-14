import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import {
  AdmissionDenied,
  AdmissionExpired,
  type AccessAdmissionRegistry,
  type RegisteredAdmission,
} from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { readComponentState } from '../work/history.ts';
import {
  DATASET,
  GRAPHS,
  ID,
  RV,
  hash,
  iri,
  lit,
  prepareComponent,
  IdempotencyConflict,
  PendingActivation,
  CancelledActivation,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT, CLASSIFICATION_ISOLATE_POLICY } from './context.ts';
import { ensureGlobalClassificationContext } from './global.ts';
import {
  CLASSIFICATION_PROPOSITION_PROFILE,
  ClassificationDefinitionUnavailable,
  classificationPropositionReceiptIri,
  readClassificationPropositionReceipt,
  sealClassificationPropositionAdmission,
  type ClassificationPropositionReceipt,
  type PropositionDefinitions,
} from './proposition.ts';

export const VOCABULARY_PROFILE = 'https://rezics.com/definition/classification-proposition-v2';
export const VOCABULARY_REVISION_PROFILE =
  'https://rezics.com/definition/concept-scheme-revision-v1';
export const classificationModelRevisions = (variable: string) =>
  `VALUES ${variable} { ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ${iri(VOCABULARY_PROFILE)} }`;
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const language = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const label = /^[^\u0000-\u001f\u007f]{1,120}$/u;
export const VOCABULARY_COST = {
  labels: 8,
  alternativeLabels: 16,
  relations: 8,
  graphReads: 16,
  validations: 8,
  deadlineMs: 10_000,
} as const;
export class InvalidVocabularyInput extends Error {}

export interface VocabularyLabel {
  language: string;
  value: string;
}
export interface DefineVocabularyConceptInput {
  actingSubject: string;
  scheme: { id: string; expectedHead: string } | null;
  labels: VocabularyLabel[];
  alternativeLabels: VocabularyLabel[];
  broader: string[];
  narrower: string[];
}
export interface VocabularyReceipt extends ClassificationPropositionReceipt {
  schemeHead?: string;
  conceptHead?: string;
}
export interface RetireVocabularyConceptInput {
  actingSubject: string;
  concept: { id: string; expectedHead: string };
  state: 'retired';
  scheme?: DefineVocabularyConceptInput['scheme'];
  labels?: VocabularyLabel[];
  alternativeLabels?: VocabularyLabel[];
  broader?: string[];
  narrower?: string[];
}
export type VocabularyCommandInput = DefineVocabularyConceptInput | RetireVocabularyConceptInput;

/** Structural owner validation also serves restoration while audience reads are fenced. */
export async function currentConceptValidations(env: WorkActivationEnvironment, concept: string,
  profile: 'classification-proposition-v1' | 'classification-proposition-v2') {
  if (!native.test(concept)) throw new InvalidVocabularyInput('invalid Concept identity');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX skos: <${SKOS}>
    SELECT ?scheme ?concept ?path ?expression ?sense WHERE { GRAPH ${iri(GRAPHS.current)} {
      BIND(${iri(concept)} AS ?concept)
      ?concept a skos:Concept ; skos:inScheme ?scheme .
      ?path a rv:ConceptPath ; rv:terminalConcept ?concept .
      ?expression a rv:ClassificationExpression ; rv:path ?path ; rv:assertedConcept ?concept .
      ?sense a rv:ClassificationSense ; rv:path ?path ; rv:expression ?expression .
    } } LIMIT 2`, 4096)).results?.bindings ?? [];
  const row = rows[0];
  const roles = ['scheme', 'concept', 'path', 'expression', 'sense'] as const;
  if (rows.length !== 1 || roles.some(role => row?.[role]?.type !== 'uri' || !native.test(row[role]!.value)))
    throw new ClassificationDefinitionUnavailable('Concept owner binding is unavailable or ambiguous');
  const definitions = Object.fromEntries(roles.map(role => [role, row![role]!.value])) as unknown as PropositionDefinitions;
  const validations = await profileValidations(env.fuseki, profile, roles.map(role => ({
    shape: `https://rezics.com/definition/${profile}/${role}-shape`,
    focus: [definitions[role]], graphs: [GRAPHS.current],
  })), { ...definitions });
  const guard = `GRAPH ${iri(GRAPHS.current)} {
    ${iri(concept)} skos:inScheme ${iri(definitions.scheme)} .
    ${iri(definitions.path)} rv:terminalConcept ${iri(concept)} .
    ${iri(definitions.expression)} rv:path ${iri(definitions.path)} ; rv:assertedConcept ${iri(concept)} .
    ${iri(definitions.sense)} rv:path ${iri(definitions.path)} ; rv:expression ${iri(definitions.expression)} .
  }`;
  return { validations, guard };
}

function checked(input: DefineVocabularyConceptInput, labelsRequired = true) {
  const labels = [...input.labels].sort((a, b) => a.language.localeCompare(b.language));
  const alternativeLabels = [...input.alternativeLabels].sort(
    (a, b) => a.language.localeCompare(b.language) || a.value.localeCompare(b.value),
  );
  const broader = [...input.broader].sort(),
    narrower = [...input.narrower].sort();
  const validLabels = (values: VocabularyLabel[]) =>
    values.every(
      (value) =>
        language.test(value.language) &&
        label.test(value.value) &&
        value.value.trim() === value.value,
    );
  if (
    !native.test(input.actingSubject) ||
    (input.scheme && (!native.test(input.scheme.id) || !native.test(input.scheme.expectedHead))) ||
    (labelsRequired && !labels.length) ||
    labels.length > VOCABULARY_COST.labels ||
    alternativeLabels.length > VOCABULARY_COST.alternativeLabels ||
    broader.length > VOCABULARY_COST.relations ||
    narrower.length > VOCABULARY_COST.relations ||
    !validLabels(labels) ||
    !validLabels(alternativeLabels) ||
    new Set(labels.map((item) => item.language.toLowerCase())).size !== labels.length ||
    alternativeLabels.some((alt) =>
      labels.some((pref) => pref.language === alt.language && pref.value === alt.value),
    ) ||
    [...broader, ...narrower].some((id) => !native.test(id)) ||
    new Set(broader).size !== broader.length ||
    new Set(narrower).size !== narrower.length ||
    broader.some((id) => narrower.includes(id))
  ) {
    throw new InvalidVocabularyInput('invalid vocabulary proposition request');
  }
  return { ...input, labels, alternativeLabels, broader, narrower };
}

export function vocabularyDigest(input: VocabularyCommandInput) {
  const value = 'concept' in input ? checkedRetirement(input) : checked(input);
  return hash(
    JSON.stringify({
      family: 'classification-proposition-v2',
      ...value,
      scope: GLOBAL_CLASSIFICATION_CONTEXT,
    }),
  );
}

function checkedRetirement(input: RetireVocabularyConceptInput) {
  if (input.state !== 'retired' || !native.test(input.concept.id) || !native.test(input.concept.expectedHead))
    throw new InvalidVocabularyInput('invalid Concept retirement request');
  // Existing callers may send the creation envelope. Those fields bind retries,
  // but retirement preserves the stored labels and hierarchy.
  const fields = checked({ actingSubject: input.actingSubject, scheme: input.scheme ?? null,
    labels: input.labels ?? [], alternativeLabels: input.alternativeLabels ?? [],
    broader: input.broader ?? [], narrower: input.narrower ?? [] }, input.labels !== undefined);
  return { actingSubject: fields.actingSubject, concept: { id: input.concept.id, expectedHead: input.concept.expectedHead },
    state: input.state, ...(input.scheme !== undefined ? { scheme: fields.scheme } : {}),
    ...(input.labels !== undefined ? { labels: fields.labels } : {}),
    ...(input.alternativeLabels !== undefined ? { alternativeLabels: fields.alternativeLabels } : {}),
    ...(input.broader !== undefined ? { broader: fields.broader } : {}),
    ...(input.narrower !== undefined ? { narrower: fields.narrower } : {}) };
}

/** Access admits the existing command. Its native first revision fixes which
 * Agent's Concept it affects; appending to a scheme never transfers stewardship. */
function conceptStewardGuard(input: RetireVocabularyConceptInput) {
  return `GRAPH ${iri(GRAPHS.current)} { ${iri(input.concept.id)} a <${SKOS}Concept> ;
      rv:definitionProfile ${iri(VOCABULARY_PROFILE)} . }
    GRAPH ${iri(GRAPHS.revisions)} { ?first a rv:RevisionAnchor ; rv:component ${iri(input.concept.id)} ;
      rv:recordedBy ${iri(input.actingSubject)} ; rv:modelRevision ${iri(VOCABULARY_PROFILE)} .
      FILTER NOT EXISTS { ?first rv:predecessor ?previous }
      FILTER NOT EXISTS { ?first a rv:ErasedRevision }
    }
    GRAPH ${iri(GRAPHS.receipts)} { ?creation rv:concept ${iri(input.concept.id)} ; rv:conceptRevision ?first ;
      rv:outcome rv:Succeeded ; rv:admittedScope "classification:define:global" . }`;
}

async function assertConceptSteward(env: WorkActivationEnvironment, input: RetireVocabularyConceptInput) {
  if ((await env.fuseki.query(`PREFIX rv: <${RV}> ASK { ${conceptStewardGuard(input)} }`, 1024)).boolean !== true)
    throw new AdmissionDenied('Concept steward authority is required');
}

export async function retireVocabularyConcept(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: RetireVocabularyConceptInput): Promise<VocabularyReceipt> {
  const value = checkedRetirement(input), digest = vocabularyDigest(value);
  if (admission.action !== 'classification.proposition.define' || admission.scope !== 'classification:define:global'
    || admission.actingSubject !== value.actingSubject || admission.requestDigest !== digest)
    throw new IdempotencyConflict('vocabulary retirement admission differs from intent');
  const checkedReceipt = (receipt: VocabularyReceipt) => {
    if (receipt.requestDigest !== digest || receipt.admissionId !== admission.id
      || receipt.authorityEpoch !== admission.authorityEpoch || receipt.scope !== admission.scope)
      throw new IdempotencyConflict('vocabulary retirement receipt differs from admission');
    return receipt;
  };
  const prior = await readClassificationPropositionReceipt(env, admission.id);
  if (prior) return checkedReceipt(prior);
  if (Date.parse(admission.expiresAt) <= Date.now()) throw new PendingActivation('admission expired');
  await assertConceptSteward(env, value);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX skos: <${SKOS}>
    SELECT ?scheme ?schemeHead ?path ?expression ?sense ?revision ?manifest WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(value.concept.id)} skos:inScheme ?scheme ; rv:head ${iri(value.concept.expectedHead)} ; rv:conceptState rv:Active .
        ?scheme rv:schemeRevisionHead ?schemeHead ; rv:schemeState rv:Active .
        ?path a rv:ConceptPath ; rv:terminalConcept ${iri(value.concept.id)} .
        ?expression a rv:ClassificationExpression ; rv:path ?path ; rv:assertedConcept ${iri(value.concept.id)} .
        ?sense a rv:ClassificationSense ; rv:path ?path ; rv:expression ?expression ; rv:head ?revision .
      }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(value.concept.expectedHead)} rv:component ${iri(value.concept.id)} ; rv:manifest ?manifest . }
    } LIMIT 2`, 4096)).results?.bindings ?? [];
  const row = rows[0];
  if (!row || (value.scheme && (row.scheme?.value !== value.scheme.id || row.schemeHead?.value !== value.scheme.expectedHead)))
    return sealClassificationPropositionAdmission(env, admission);
  if (rows.length !== 1 || ['scheme', 'schemeHead', 'path', 'expression', 'sense', 'revision'].some(key =>
    row[key]?.type !== 'uri' || !native.test(row[key]!.value)) || !row.manifest)
    throw new PendingActivation('Concept owner binding is unavailable or ambiguous');
  const definitions: PropositionDefinitions = { scheme: row.scheme!.value, concept: value.concept.id,
    path: row.path!.value, expression: row.expression!.value, sense: row.sense!.value };
  const schemeHead = row.schemeHead!.value, revision = row.revision!.value;
  const retained = readComponentState(env.objectDirectory, row.manifest.value, value.concept.id, VOCABULARY_PROFILE);
  const conceptHead = ID + Bun.randomUUIDv7(), operation = ID + Bun.randomUUIDv7();
  const manifest = prepareComponent(env.objectDirectory, value.concept.id, { ...retained,
    state: 'retired', previousHead: value.concept.expectedHead, actingSubject: value.actingSubject }, VOCABULARY_PROFILE);
  const validations = [...(await currentConceptValidations(env, value.concept.id, 'classification-proposition-v2')).validations,
    ...await profileValidations(env.fuseki, 'concept-scheme-revision-v1', [{
    shape: `${VOCABULARY_REVISION_PROFILE}/anchor-shape`, focus: [conceptHead], graphs: [GRAPHS.revisions],
  }])];
  const receipt = classificationPropositionReceiptIri(admission.id), batch = `urn:rezics:outbox:${hash(receipt)}`,
    event = `urn:rezics:event:${hash(operation)}`;
  const result = await validatedCommand(env, { receipt, digest, validations, deadlineMs: VOCABULARY_COST.deadlineMs,
    update: `PREFIX rv: <${RV}> PREFIX skos: <${SKOS}>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(value.concept.id)} rv:head ${iri(value.concept.expectedHead)} ; rv:conceptState rv:Active }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(value.concept.id)} rv:head ${iri(conceptHead)} ; rv:conceptState rv:Retired }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(conceptHead)} a rv:RevisionAnchor ; rv:component ${iri(value.concept.id)} ;
        rv:operation ${iri(operation)} ; rv:recordedBy ${iri(value.actingSubject)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:modelRevision ${iri(VOCABULARY_PROFILE)} ; rv:shapeRevision ${iri(VOCABULARY_PROFILE)} ;
        rv:predecessor ${iri(value.concept.expectedHead)} ; rv:conceptState rv:Retired ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
        rv:expectedHead ${iri(value.concept.expectedHead)} ; rv:action "classification.proposition.define" ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
        rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:Succeeded ;
        rv:scheme ${iri(definitions.scheme)} ; rv:concept ${iri(definitions.concept)} ; rv:path ${iri(definitions.path)} ;
        rv:expression ${iri(definitions.expression)} ; rv:sense ${iri(definitions.sense)} ; rv:definitionRevision ${iri(revision)} ;
        rv:schemeRevision ${iri(schemeHead)} ; rv:conceptRevision ${iri(conceptHead)} ;
        rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:ClassificationPropositionDefinedEvent ; rv:ordinal 0 ;
        rv:action "classification.proposition.define" ; rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(value.concept.id)} skos:inScheme ${iri(definitions.scheme)} ;
        rv:head ${iri(value.concept.expectedHead)} ; rv:conceptState rv:Active .
        FILTER NOT EXISTS { ${iri(value.concept.id)} rv:conceptState rv:Retired }
        FILTER NOT EXISTS { ${iri(value.concept.id)} rv:protectionHead ?protection }
        ${iri(definitions.scheme)} rv:schemeState rv:Active ; rv:schemeRevisionHead ${iri(schemeHead)} .
        ${iri(definitions.sense)} rv:head ${iri(revision)} . }
      ${conceptStewardGuard(value)}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(conceptHead)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }` }, admission);
  const committed = await readClassificationPropositionReceipt(env, admission.id);
  if (committed) return checkedReceipt(committed);
  if (result.status === 'guard-unmatched') return sealClassificationPropositionAdmission(env, admission);
  throw new PendingActivation('Concept retirement outcome unknown');
}

/** One guarded append to a scheme, with a new head for the scheme and the new Concept. */
export async function defineVocabularyConcept(
  env: WorkActivationEnvironment,
  admission: RegisteredAdmission,
  input: DefineVocabularyConceptInput,
): Promise<VocabularyReceipt> {
  const value = checked(input),
    digest = vocabularyDigest(value);
  if (
    admission.action !== 'classification.proposition.define' ||
    admission.scope !== 'classification:define:global' ||
    admission.actingSubject !== value.actingSubject ||
    admission.requestDigest !== digest
  ) {
    throw new IdempotencyConflict('vocabulary admission differs from intent');
  }
  const prior = await readClassificationPropositionReceipt(env, admission.id);
  if (prior) {
    if (
      prior.requestDigest !== digest ||
      prior.admissionId !== admission.id ||
      prior.authorityEpoch !== admission.authorityEpoch ||
      prior.scope !== admission.scope
    ) {
      throw new IdempotencyConflict('vocabulary receipt differs from admission');
    }
    return prior;
  }
  if (Date.parse(admission.expiresAt) <= Date.now())
    throw new PendingActivation('admission expired');
  await ensureGlobalClassificationContext(env);
  const definitions: PropositionDefinitions = {
    scheme: value.scheme?.id ?? ID + Bun.randomUUIDv7(),
    concept: ID + Bun.randomUUIDv7(),
    path: ID + Bun.randomUUIDv7(),
    expression: ID + Bun.randomUUIDv7(),
    sense: ID + Bun.randomUUIDv7(),
  };
  const schemeHead = ID + Bun.randomUUIDv7(),
    conceptHead = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7(),
    operation = ID + Bun.randomUUIDv7();
  const schemeManifest = prepareComponent(
    env.objectDirectory,
    definitions.scheme,
    {
      profile: VOCABULARY_PROFILE,
      scheme: definitions.scheme,
      previousHead: value.scheme?.expectedHead ?? null,
      addedConcept: definitions.concept,
      actingSubject: value.actingSubject,
    },
    VOCABULARY_PROFILE,
  );
  const conceptManifest = prepareComponent(
    env.objectDirectory,
    definitions.concept,
    {
      profile: VOCABULARY_PROFILE,
      concept: definitions.concept,
      scheme: definitions.scheme,
      labels: value.labels,
      alternativeLabels: value.alternativeLabels,
      broader: value.broader,
      narrower: value.narrower,
      actingSubject: value.actingSubject,
    },
    VOCABULARY_PROFILE,
  );
  const manifest = prepareComponent(
    env.objectDirectory,
    definitions.sense,
    {
      profile: VOCABULARY_PROFILE,
      ...definitions,
      labels: value.labels,
      alternativeLabels: value.alternativeLabels,
      broader: value.broader,
      narrower: value.narrower,
      actingSubject: value.actingSubject,
      previousSchemeHead: value.scheme?.expectedHead ?? null,
      schemeHead,
      conceptHead,
      schemeManifest: `urn:rezics:sha256:${schemeManifest}`,
      conceptManifest: `urn:rezics:sha256:${conceptManifest}`,
      scope: GLOBAL_CLASSIFICATION_CONTEXT,
    },
    VOCABULARY_PROFILE,
  );
  const validations = [
    ...(await profileValidations(
      env.fuseki,
      'classification-proposition-v2',
      (Object.entries(definitions) as [keyof PropositionDefinitions, string][]).map(
        ([role, focus]) => ({
          shape: `${VOCABULARY_PROFILE}/${role}-shape`,
          focus: [focus],
          graphs: [GRAPHS.current],
        }),
      ),
      { ...definitions },
    )),
    ...(await profileValidations(
      env.fuseki,
      'concept-scheme-revision-v1',
      [schemeHead, conceptHead, revision].map((focus) => ({
        shape: `${VOCABULARY_REVISION_PROFILE}/anchor-shape`,
        focus: [focus],
        graphs: [GRAPHS.revisions],
      })),
    )),
  ];
  const receipt = classificationPropositionReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`,
    event = `urn:rezics:event:${hash(operation)}`;
  const relationGuards = [...value.broader, ...value.narrower]
    .map(
      (id) =>
        `GRAPH ${iri(GRAPHS.current)} { ${iri(id)} a skos:Concept ; skos:inScheme ${iri(definitions.scheme)} ;
      rv:conceptState rv:Active . FILTER NOT EXISTS { ${iri(id)} rv:conceptState rv:Retired } }`,
    )
    .join('\n');
  const schemeGuard = value.scheme
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(definitions.scheme)} a skos:ConceptScheme ;
        rv:schemeState rv:Active ; rv:schemeRevisionHead ${iri(value.scheme.expectedHead)} . }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(definitions.scheme)} ?p ?o } }`;
  const schemeInsert = value.scheme
    ? `${iri(definitions.scheme)} rv:schemeRevisionHead ${iri(schemeHead)} .`
    : `${iri(definitions.scheme)} a skos:ConceptScheme, rv:VocabularyDefinition ;
      rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:schemeState rv:Active ;
      rv:schemeRevisionHead ${iri(schemeHead)} .`;
  const revisionTriples = (
    id: string,
    component: string,
    objectManifest: string,
    previous: string | null,
  ) =>
    `${iri(id)} a rv:RevisionAnchor ; rv:component ${iri(component)} ; rv:operation ${iri(operation)} ;
      rv:recordedBy ${iri(value.actingSubject)} ; rv:manifest ${iri(`urn:rezics:sha256:${objectManifest}`)} ;
      rv:modelRevision ${iri(VOCABULARY_PROFILE)} ; rv:shapeRevision ${iri(VOCABULARY_PROFILE)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next${
        previous ? ` ; rv:predecessor ${iri(previous)}` : ''
      } .`;
  let error: unknown, status: string | undefined;
  try {
    const result = await validatedCommand(
      env,
      {
        receipt,
        digest,
        validations,
        deadlineMs: VOCABULARY_COST.deadlineMs,
        update: `PREFIX rv: <${RV}> PREFIX skos: <${SKOS}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        ${value.scheme ? `GRAPH ${iri(GRAPHS.current)} { ${iri(definitions.scheme)} rv:schemeRevisionHead ${iri(value.scheme.expectedHead)} }` : ''} }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} {
          ${schemeInsert}
          ${iri(definitions.concept)} a skos:Concept, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; skos:inScheme ${iri(definitions.scheme)} ;
            rv:conceptState rv:Active ; rv:head ${iri(conceptHead)} ;
            skos:prefLabel ${value.labels.map((item) => `${lit(item.value)}@${item.language}`).join(', ')} .
          ${value.alternativeLabels.map((item) => `${iri(definitions.concept)} skos:altLabel ${lit(item.value)}@${item.language} .`).join('\n')}
          ${value.broader.map((id) => `${iri(definitions.concept)} skos:broader ${iri(id)} .`).join('\n')}
          ${value.narrower.map((id) => `${iri(definitions.concept)} skos:narrower ${iri(id)} .`).join('\n')}
          ${iri(definitions.path)} a rv:ConceptPath, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:pathKind rv:SingleConcept ;
            rv:pathLength 1 ; rv:terminalConcept ${iri(definitions.concept)} ; rv:pathState rv:Active .
          ${iri(definitions.expression)} a rv:ClassificationExpression, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:path ${iri(definitions.path)} ;
            rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept ${iri(definitions.concept)} ;
            rv:expressionState rv:Active .
          ${iri(definitions.sense)} a rv:ClassificationSense, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(VOCABULARY_PROFILE)} ; rv:path ${iri(definitions.path)} ;
            rv:expression ${iri(definitions.expression)} ; rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
            rv:senseState rv:Active ; rv:head ${iri(revision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${revisionTriples(schemeHead, definitions.scheme, schemeManifest, value.scheme?.expectedHead ?? null)}
          ${revisionTriples(conceptHead, definitions.concept, conceptManifest, null)}
          ${revisionTriples(revision, definitions.sense, manifest, null)}
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
            rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(admission.id)} ;
            rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
            rv:outcome rv:Succeeded ; rv:scheme ${iri(definitions.scheme)} ; rv:concept ${iri(definitions.concept)} ;
            rv:path ${iri(definitions.path)} ; rv:expression ${iri(definitions.expression)} ;
            rv:sense ${iri(definitions.sense)} ; rv:definitionRevision ${iri(revision)} ;
            rv:schemeRevision ${iri(schemeHead)} ; rv:conceptRevision ${iri(conceptHead)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
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
        GRAPH ${iri(GRAPHS.current)} { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        ${schemeGuard}
        ${relationGuards}
        ${Object.entries(definitions)
          .filter(([key]) => key !== 'scheme')
          .map(
            ([, id]) => `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(id)} ?p ?o } }`,
          )
          .join('\n')}
        ${[schemeHead, conceptHead, revision].map(id =>
          `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(id)} ?p ?o } }`).join('\n')}
        BIND(?n + 1 AS ?next)
      }`,
      },
      admission,
    );
    status = result.status;
  } catch (caught) {
    error = caught;
  }
  const committed = await readClassificationPropositionReceipt(env, admission.id);
  if (
    committed &&
    committed.requestDigest === digest &&
    committed.admissionId === admission.id &&
    committed.authorityEpoch === admission.authorityEpoch &&
    committed.scope === admission.scope
  )
    return committed;
  if (status === 'guard-unmatched') {
    const guard = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX skos: <${SKOS}> ASK {
      GRAPH ${iri(GRAPHS.current)} {
        ${value.scheme ? `${iri(definitions.scheme)} rv:schemeRevisionHead ${iri(value.scheme.expectedHead)} .` : ''}
        ${[...value.broader, ...value.narrower]
          .map(
            (id) =>
              `${iri(id)} a skos:Concept ; skos:inScheme ${iri(definitions.scheme)} ; rv:conceptState rv:Active .`,
          )
          .join('\n')}
      } }`);
    if (guard.boolean === false) {
      const cancelled = await sealClassificationPropositionAdmission(env, admission);
      if (cancelled.outcome === 'cancelled') return cancelled;
    }
  }
  throw new PendingActivation(
    error ? 'vocabulary update outcome unknown' : 'vocabulary guard did not match',
  );
}

export async function defineAdmittedVocabularyConcept(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: VocabularyCommandInput & { idempotencyKey: string },
): Promise<VocabularyReceipt & { replayed: boolean }> {
  const digest = vocabularyDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['classification:define']);
  if ('concept' in input) await assertConceptSteward(env, input);
  const registered = await access.register({
    principal,
    actingSubject: input.actingSubject,
    scope: 'classification:define:global',
    action: 'classification.proposition.define',
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
  });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try {
        admission = await access.claim(registered.id, digest, principal);
      } catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealClassificationPropositionAdmission(env, admission);
      } else if ('concept' in input) await retireVocabularyConcept(env, admission, input);
      else await defineVocabularyConcept(env, admission, input);
    }
    const terminal = await readClassificationPropositionReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'classification-proposition');
    await access.recordGraphOutcome(registered.id, terminal);
    if (
      terminal.requestDigest !== digest ||
      terminal.admissionId !== registered.id ||
      terminal.authorityEpoch !== registered.authorityEpoch ||
      terminal.scope !== registered.scope
    ) {
      throw new IdempotencyConflict('vocabulary admission differs from graph receipt');
    }
    if (terminal.outcome === 'cancelled')
      throw new CancelledActivation('vocabulary definition was cancelled');
    if (!terminal.schemeHead || !terminal.conceptHead) {
      throw new IdempotencyConflict('vocabulary receipt has no revision heads');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (
      error instanceof IdempotencyConflict ||
      error instanceof CancelledActivation ||
      error instanceof InvalidVocabularyInput || error instanceof AdmissionDenied
    )
      throw error;
    throw new PendingAdmittedWork(registered.id, 'classification-proposition');
  }
}
