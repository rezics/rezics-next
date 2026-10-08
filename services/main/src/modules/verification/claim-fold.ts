import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import {
  GRAPHS,
  DATASET,
  ID,
  RV,
  hash,
  lit,
  iri,
  prepareComponent,
  type WorkActivationEnvironment,
} from '../work/activate.ts';
import {
  prepareRetainedClaimStatementMeaning,
  retainedClaimStatementTerm,
  retainedClaimStatementObjectTerm,
} from '../statement/graph.ts';
import {
  DATE_PUBLISHED_PREDICATE,
  validateRetainedClaimStatementDefinitions,
  normalizeStatementRetainedClaimProvenance,
  statementQualificationTriples,
  statementRetainedClaimProvenanceTriples,
} from '../statement/qualification.ts';
import {
  STATEMENT_PROFILE,
  statementMeaningKey,
  type StatementMeaning,
  type StatementRetainedClaimProvenance,
} from '../statement/schema.ts';
import type { AssessmentHistoryCursor } from '../access/assessment-history.ts';
import { native, CLAIM_PROFILE, ADMISSIONS, receiptIri } from './graph.ts';
import type { AssessmentProducerPermit } from './assessment-producer.ts';
import { ASSESSMENT_HISTORY_AUDIT_COST, auditAssessmentHistoryWindow } from './operations.ts';
import type { VerificationStore } from './store.ts';
import {
  assertClaimFoldCustodyText,
  readClaimFoldCustody,
  type ClaimFoldCustodyBytes,
} from './claim-fold-custody.ts';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const CLAIM_STATEMENT_FOLD_COST = {
  claims: 32,
  currentQuads: 16,
  revisionQuads: 40,
  responseBytes: 256 * 1024,
  deadlineMs: 30_000,
} as const;
const FAMILY = 'claim-statement-fold-v1';
const PREFIX = 'urn:rezics:name-migration:claim-statement-fold:';
type Term = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
type Property = { predicate: string; object: Term };
export interface ClaimStatementFoldInput {
  claim: string;
  claimRevision: string;
  relationDefinition: string;
  qualificationDefinition: string;
}
export interface ClaimStatementFoldMap {
  relationDefinition: string;
  qualificationDefinition: string;
}
export interface ClaimStatementFoldFence {
  marker: string;
  mapDigest: string;
  job: string;
}
export interface PreparedClaimStatementFold extends ClaimStatementFoldInput {
  sealedBytes: {
    relationManifest: string;
    relationPayload: string;
    qualificationManifest: string;
    qualificationPayload: string;
    statementManifest: string;
    statementPayload: string;
  };
  statementRevision: string;
  meaning: StatementMeaning;
  meaningKey: string;
  provenance: StatementRetainedClaimProvenance;
  sourceOperation: string;
  sourceEpoch: string;
  sourceSequence: string;
  sourceDigest: string;
  current: string;
  revisions: string;
  historicalCurrent: string;
  sourceReceipt: string;
  definitionGuard: string;
  sourceGuard: string;
  validations: Awaited<ReturnType<typeof profileValidations>>;
}
export type ClaimStatementFoldPreparation =
  | { status: 'eligible'; prepared: PreparedClaimStatementFold }
  | { status: 'retained'; claim: string; reason: string };
export class ClaimStatementFoldNativeHookRequired extends Error {}
export class ClaimStatementFoldStale extends Error {}
export class ClaimStatementFoldUnavailable extends Error {}
export class ClaimStatementFoldBudgetExpired extends Error {}

function term(value: Term): string {
  if (value.type === 'uri') return retainedClaimStatementTerm(value.value);
  if (value.type !== 'literal')
    throw new ClaimStatementFoldUnavailable('retained blank nodes are unsupported');
  if (value['xml:lang']) return `${lit(value.value)}@${value['xml:lang']}`;
  return `${lit(value.value)}^^${retainedClaimStatementTerm(value.datatype ?? `${XSD}string`)}`;
}
function termIdentity(value: Term) {
  return [
    value.type,
    value.value,
    value.type === 'literal'
      ? (value.datatype ?? (value['xml:lang'] ? `${RDF}langString` : `${XSD}string`))
      : null,
    value['xml:lang'] ?? null,
  ];
}
function signature(value: Term) {
  return JSON.stringify(termIdentity(value));
}
function one(
  properties: readonly Property[],
  predicate: string,
  optional = false,
): Term | undefined {
  const values = properties
    .filter((item) => item.predicate === predicate)
    .map((item) => item.object);
  if (values.length > 1 || (!optional && values.length !== 1)) {
    throw new ClaimStatementFoldUnavailable('retained Claim fields are incomplete or ambiguous');
  }
  return values[0];
}
function reference(
  properties: readonly Property[],
  predicate: string,
  optional = false,
): string | undefined {
  const value = one(properties, predicate, optional);
  if (value && value.type !== 'uri')
    throw new ClaimStatementFoldUnavailable('retained reference is not an IRI');
  return value?.value;
}
function lexical(properties: readonly Property[], predicate: string, datatype: string): string {
  const value = one(properties, predicate)!;
  if (
    value.type !== 'literal' ||
    value['xml:lang'] ||
    (value.datatype ?? `${XSD}string`) !== datatype
  ) {
    throw new ClaimStatementFoldUnavailable('retained literal has another datatype');
  }
  return value.value;
}
function triples(subject: string, properties: readonly Property[]): string {
  return properties
    .map(
      (item) =>
        `${retainedClaimStatementTerm(subject)} ${retainedClaimStatementTerm(item.predicate)} ${term(item.object)} .`,
    )
    .join('\n');
}
async function properties(
  env: WorkActivationEnvironment,
  graph: string,
  subject: string,
  limit: number,
): Promise<Property[]> {
  const rows =
    (
      await env.fuseki.query(
        `SELECT ?predicate ?object WHERE { GRAPH ${iri(graph)} {
    ${iri(subject)} ?predicate ?object } } LIMIT ${limit + 1}`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      )
    ).results?.bindings ?? [];
  if (rows.length > limit || rows.some((row) => row.predicate?.type !== 'uri' || !row.object)) {
    throw new ClaimStatementFoldUnavailable('retained record exceeds its fixed footprint');
  }
  return rows
    .map((row) => ({ predicate: row.predicate!.value, object: row.object! }))
    .sort(
      (a, b) =>
        a.predicate.localeCompare(b.predicate) ||
        signature(a.object).localeCompare(signature(b.object)),
    );
}
const deterministicRevision = (claim: string, revision: string, digest: string) => {
  const id = hash(JSON.stringify([FAMILY, claim, revision, digest])).slice(0, 32);
  return `${ID}${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
};

/** One explicit root, its immutable fields and the original successful receipt; no history inference. */
export async function prepareClaimStatementFold(
  env: WorkActivationEnvironment,
  input: ClaimStatementFoldInput,
): Promise<ClaimStatementFoldPreparation> {
  native(input.claim, 'claim');
  native(input.claimRevision, 'claimRevision');
  const map = claimStatementFoldFence(env, input, 'prepare').mapDigest;
  const held =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:restoreHold true } }`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      )
    ).boolean === true;
  if (
    held &&
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ?marker rv:claimStatementFoldFence true ; rv:foldMapDigest ${lit(map)} } }`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      )
    ).boolean !== true
  ) {
    throw new ClaimStatementFoldUnavailable(
      'Complete the original restore before preparing Claim fold bytes',
    );
  }
  const retained = (reason: string): ClaimStatementFoldPreparation => ({
    status: 'retained',
    claim: input.claim,
    reason,
  });
  try {
    const [current, source, roots, receipts] = await Promise.all([
      properties(env, GRAPHS.current, input.claim, CLAIM_STATEMENT_FOLD_COST.currentQuads),
      properties(
        env,
        GRAPHS.revisions,
        input.claimRevision,
        CLAIM_STATEMENT_FOLD_COST.revisionQuads,
      ),
      env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?revision WHERE { GRAPH ${iri(GRAPHS.revisions)} {
        ?revision a rv:ClaimRevision ; rv:component ${iri(input.claim)} } } LIMIT 2`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      ),
      env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?receipt ?operation ?admission ?digest ?epoch ?scope ?dataEpoch ?sequence WHERE {
        GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
          rv:claim ${iri(input.claim)} ; rv:claimRevision ${iri(input.claimRevision)} ; rv:operation ?operation ;
          rv:admissionId ?admission ; rv:requestDigest ?digest ; rv:authorityEpoch ?epoch ; rv:admittedScope ?scope ;
          rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence } } LIMIT 2`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      ),
    ]);
    if (reference(source, `${RV}component`) !== input.claim)
      return retained('source-component-differs');
    const predicate = reference(source, `${RV}propositionPredicate`);
    if (predicate !== DATE_PUBLISHED_PREDICATE) return retained('predicate-unreviewed');
    const rootRows = roots.results?.bindings ?? [];
    if (
      rootRows.length !== 1 ||
      rootRows[0]?.revision?.value !== input.claimRevision ||
      one(source, `${RV}predecessor`, true)
    )
      return retained('history-not-one-root');
    const currentFields = new Set([
      `${RDF}type`,
      `${RV}referent`,
      `${RV}interpretationContext`,
      `${RV}propositionPredicate`,
      `${RV}claimHead`,
      `${RV}claimState`,
    ]);
    if (
      current.length !== currentFields.size ||
      current.some((item) => !currentFields.has(item.predicate)) ||
      reference(current, `${RDF}type`) !== `${RV}Claim` ||
      reference(current, `${RV}claimState`) !== `${RV}Active` ||
      reference(current, `${RV}claimHead`) !== input.claimRevision
    )
      return retained('current-head-or-shape-differs');
    for (const field of ['referent', 'interpretationContext', 'propositionPredicate']) {
      if (reference(current, `${RV}${field}`) !== reference(source, `${RV}${field}`))
        return retained('identity-differs');
    }
    const sourceFields = new Set([
      `${RDF}type`,
      ...[
        'component',
        'referent',
        'interpretationContext',
        'propositionPredicate',
        'propositionValue',
        'valuePrecision',
        'valueQualifier',
        'validFrom',
        'validUntil',
        'editionScope',
        'claimStatus',
        'derivation',
        'statedBy',
        'recordedAt',
        'modelRevision',
        'shapeRevision',
        'dataEpoch',
        'sequence',
      ].map((field) => `${RV}${field}`),
    ]);
    const types = source
      .filter((item) => item.predicate === `${RDF}type`)
      .map((item) => item.object.value)
      .sort();
    if (
      source.some((item) => !sourceFields.has(item.predicate)) ||
      source.some((item) => item.predicate === `${RDF}type` && item.object.type !== 'uri') ||
      JSON.stringify(types) !==
        JSON.stringify([`${RV}ClaimRevision`, `${RV}RevisionAnchor`].sort()) ||
      reference(source, `${RV}claimStatus`) !== `${RV}Asserted` ||
      reference(source, `${RV}modelRevision`) !== CLAIM_PROFILE ||
      reference(source, `${RV}shapeRevision`) !== CLAIM_PROFILE
    ) {
      return retained('source-shape-unreviewed');
    }
    const value = one(source, `${RV}propositionValue`)!;
    if (
      value.type !== 'literal' ||
      value['xml:lang'] ||
      ![`${XSD}date`, `${XSD}dateTime`].includes(value.datatype ?? '')
    ) {
      return retained('publication-date-value-unsupported');
    }
    const sourceEpoch = lexical(source, `${RV}dataEpoch`, `${XSD}string`);
    const sourceSequence = lexical(source, `${RV}sequence`, `${XSD}integer`);
    if (!/^[1-9][0-9]*$/.test(sourceSequence)) return retained('source-position-invalid');
    const original = receipts.results?.bindings ?? [];
    if (original.length !== 1) return retained('source-receipt-unavailable');
    const receipt = original[0]!;
    if (
      receipt.receipt?.type !== 'uri' ||
      receipt.operation?.type !== 'uri' ||
      receipt.receipt?.value !== receiptIri(receipt.admission?.value ?? '', 'claim-create') ||
      receipt.scope?.value !== ADMISSIONS['claim-create'].scope ||
      !/^[0-9a-f]{64}$/.test(receipt.digest?.value ?? '') ||
      receipt.dataEpoch?.value !== sourceEpoch ||
      receipt.sequence?.value !== sourceSequence ||
      !/^[0-9]+$/.test(receipt.epoch?.value ?? '')
    )
      return retained('source-receipt-differs');
    const speaker = native(reference(source, `${RV}statedBy`)!, 'statedBy');
    const operation = native(receipt.operation!.value, 'sourceOperation');
    const provenance = normalizeStatementRetainedClaimProvenance({
      retainedSourceRevision: input.claimRevision,
      retainedSourceReceipt: receipt.receipt!.value,
      recordedAt: lexical(source, `${RV}recordedAt`, `${XSD}dateTime`),
      ...(reference(source, `${RV}derivation`, true)
        ? { derivation: reference(source, `${RV}derivation`, true)! }
        : {}),
    });
    const precisions: Record<string, string> = {
      [`${RV}ExactValue`]: 'exact',
      [`${RV}ApproximateValue`]: 'approximate',
      [`${RV}UncertainValue`]: 'uncertain',
    };
    const qualifiers: Record<string, string> = {
      [`${RV}DisputedAttribution`]: 'disputed-attribution',
      [`${RV}InferredValue`]: 'inferred',
    };
    if (
      source
        .filter((item) => item.predicate === `${RV}valueQualifier`)
        .some((item) => item.object.type !== 'uri' || !qualifiers[item.object.value]) ||
      ['validFrom', 'validUntil'].some((field) => {
        const bound = one(source, `${RV}${field}`, true);
        return (
          bound &&
          (bound.type !== 'literal' || bound['xml:lang'] || bound.datatype !== `${XSD}dateTime`)
        );
      })
    )
      return retained('qualification-term-unsupported');
    const meaning = prepareRetainedClaimStatementMeaning({
      subject: reference(source, `${RV}referent`)!,
      predicate,
      relationDefinition: input.relationDefinition,
      value: { kind: 'literal', lexical: value.value, datatype: value.datatype!, language: null },
      qualification: {
        definition: input.qualificationDefinition,
        interpretationContext: reference(source, `${RV}interpretationContext`)!,
        valuePrecision: precisions[reference(source, `${RV}valuePrecision`)!] as 'exact',
        valueQualifiers: source
          .filter((item) => item.predicate === `${RV}valueQualifier`)
          .map((item) => qualifiers[item.object.value]) as 'inferred'[],
        validFrom: one(source, `${RV}validFrom`, true)?.value ?? null,
        validUntil: one(source, `${RV}validUntil`, true)?.value ?? null,
        editionScope: reference(source, `${RV}editionScope`, true) ?? null,
      },
    });
    const custody = new Map<string, ClaimFoldCustodyBytes>();
    const definitions = await validateRetainedClaimStatementDefinitions(
      env,
      input,
      undefined,
      async (sourceEnv, manifest, component, profile) => {
        const exact = await readClaimFoldCustody(sourceEnv, manifest, component, profile);
        custody.set(manifest, exact);
        return exact.state;
      },
    );
    const meaningKey = statementMeaningKey(meaning);
    const sourceDigest = hash(
      JSON.stringify([
        current.map((item) => [item.predicate, termIdentity(item.object)]),
        source.map((item) => [item.predicate, termIdentity(item.object)]),
        [
          'receipt',
          'operation',
          'admission',
          'digest',
          'epoch',
          'scope',
          'dataEpoch',
          'sequence',
        ].map((field) => termIdentity(receipt[field]!)),
        input.relationDefinition,
        input.qualificationDefinition,
        meaningKey,
      ]),
    );
    const revision = deterministicRevision(input.claim, input.claimRevision, sourceDigest);
    const manifest = prepareComponent(
      env.objectDirectory,
      input.claim,
      {
        revision,
        meaning,
        meaningKey,
        speaker,
        semanticContextRevision: null,
        state: 'active',
        evidence: [],
        recordedBy: speaker,
        ...provenance,
      },
      STATEMENT_PROFILE,
    );
    const statementBytes = await readClaimFoldCustody(
      env,
      `urn:rezics:sha256:${manifest}`,
      input.claim,
      STATEMENT_PROFILE,
    );
    const relationBytes = custody.get(definitions.relation.manifest)!;
    const qualificationBytes = custody.get(definitions.qualification.manifest)!;
    const historicalCurrent = triples(input.claim, current);
    const currentRecord = `${iri(input.claim)} a <${RDF}Statement> ;
      <${RDF}subject> ${retainedClaimStatementTerm(meaning.subject)} ; <${RDF}predicate> <${predicate}> ;
      <${RDF}object> ${retainedClaimStatementObjectTerm(meaning.value)} ; rv:relationDefinition ${iri(input.relationDefinition)} ;
      ${meaning.interpretationDefinitions.map((definition) => `rv:interpretationDefinition ${iri(definition)} ;`).join(' ')}
      ${statementQualificationTriples(meaning.qualification!, true)} rv:speaker ${iri(speaker)} ; rv:meaningKey ${iri(meaningKey)} ;
      rv:retainedClaimHead ${iri(input.claimRevision)} ; rv:statementState rv:Active ; rv:head ${iri(revision)} .`;
    const revisionRecord = `${iri(revision)} a rv:StatementRevision, rv:RevisionAnchor ; rv:component ${iri(input.claim)} ;
      rv:statementState rv:Active ; rv:recordedBy ${iri(speaker)} ; rv:operation ${iri(operation)} ;
      ${statementRetainedClaimProvenanceTriples(provenance)}
      rv:modelRevision ${iri(STATEMENT_PROFILE)} ; rv:shapeRevision ${iri(STATEMENT_PROFILE)} ;
      rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:dataEpoch ${lit(sourceEpoch)} ; rv:sequence ${sourceSequence} .`;
    const validations = await profileValidations(env.fuseki, 'statement-v1', [
      {
        shape: `${STATEMENT_PROFILE}/statement-shape`,
        focus: [input.claim],
        graphs: [GRAPHS.current, GRAPHS.revisions],
      },
      {
        shape: `${STATEMENT_PROFILE}/revision-shape`,
        focus: [revision],
        graphs: [GRAPHS.current, GRAPHS.revisions],
      },
    ]);
    const sourceGuard = `GRAPH ${iri(GRAPHS.current)} { ${historicalCurrent} }
      GRAPH ${iri(GRAPHS.revisions)} { ${triples(input.claimRevision, source)} }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt.receipt!.value)} rv:claim ${iri(input.claim)} ;
        rv:claimRevision ${iri(input.claimRevision)} ; rv:outcome rv:Succeeded ; rv:operation ${iri(operation)} ;
        rv:dataEpoch ${lit(sourceEpoch)} ; rv:sequence ${sourceSequence} . }`;
    return {
      status: 'eligible',
      prepared: {
        ...input,
        sealedBytes: {
          relationManifest: relationBytes.manifest,
          relationPayload: relationBytes.payload,
          qualificationManifest: qualificationBytes.manifest,
          qualificationPayload: qualificationBytes.payload,
          statementManifest: statementBytes.manifest,
          statementPayload: statementBytes.payload,
        },
        statementRevision: revision,
        meaning,
        meaningKey,
        provenance,
        sourceOperation: operation,
        sourceEpoch,
        sourceSequence,
        sourceDigest,
        current: currentRecord,
        revisions: revisionRecord,
        historicalCurrent,
        sourceReceipt: receipt.receipt!.value,
        definitionGuard: definitions.guard,
        sourceGuard,
        validations,
      },
    };
  } catch (error) {
    if (fusekiReadBudget.getStore()?.signal.aborted)
      throw new ClaimStatementFoldBudgetExpired('Claim fold turn deadline expired');
    if (error instanceof ClaimStatementFoldUnavailable)
      return retained('retained-proof-unavailable');
    return retained('meaning-or-definition-unavailable');
  }
}

/** This fixed maintenance protocol needs the explicitly reviewed native fold hook. */
export function claimStatementFoldFence(
  env: WorkActivationEnvironment,
  map: ClaimStatementFoldMap,
  job: string,
): ClaimStatementFoldFence {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(job))
    throw new ClaimStatementFoldUnavailable('invalid fold job identity');
  const mapDigest = hash(
    JSON.stringify([
      FAMILY,
      DATE_PUBLISHED_PREDICATE,
      map.relationDefinition,
      map.qualificationDefinition,
    ]),
  );
  return {
    marker: `urn:rezics:maintenance:claim-statement-fold:${hash(JSON.stringify([env.lineage.dataEpoch, env.lineage.routingEpoch, mapDigest, job]))}`,
    mapDigest,
    job,
  };
}
function envelope(
  env: WorkActivationEnvironment,
  phase: 'acquire' | 'convert' | 'complete' | 'release',
  fence: ClaimStatementFoldFence,
  identities: readonly string[] = [],
) {
  const digest = hash(
    JSON.stringify([
      FAMILY,
      phase,
      env.lineage.dataEpoch,
      env.lineage.routingEpoch,
      fence,
      ...identities,
    ]),
  );
  const receipt = `${PREFIX}${phase}:${digest}`;
  return {
    receipt,
    digest,
    facts: `${iri(receipt)} a rv:OperationReceipt ; rv:commandFamily ${lit(`claim-statement-fold-${phase}-v1`)} ;
    rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence ; rv:claimStatementFold ${iri(fence.marker)} ;
    rv:foldMapDigest ${lit(fence.mapDigest)} ; rv:claimFoldJob ${lit(fence.job)} .`,
    control: `${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .`,
  };
}
async function ownFence(env: WorkActivationEnvironment, fence: ClaimStatementFoldFence) {
  if (
    !(
      await env.fuseki.query(
        `PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:restoreHold true .
    ${iri(fence.marker)} rv:claimStatementFoldFence true ; rv:foldMapDigest ${lit(fence.mapDigest)} } }`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      )
    ).boolean
  ) {
    throw new ClaimStatementFoldUnavailable('Claim fold owned fence is unavailable');
  }
}

async function closeAccessFence(pool: Pool, deadline: number) {
  const client = await pool.connect();
  try {
    if (performance.now() >= deadline)
      throw new ClaimStatementFoldBudgetExpired('Claim fold turn deadline expired');
    await client.query('BEGIN');
    await client.query(
      `SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - performance.now()))}ms'`,
    );
    await client.query("SET LOCAL lock_timeout = '1s'");
    // Same operator fence as restoration; the owned graph hold already stops new graph dispatch.
    const result = await client.query(`UPDATE access.recovery_fence SET open = false,
      generation = generation + CASE WHEN open THEN 1 ELSE 0 END
      WHERE id = true RETURNING generation`);
    if (result.rowCount !== 1)
      throw new ClaimStatementFoldUnavailable('Claim fold Access fence is unavailable');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertClaimFoldAdmissionsDrained(pool: Pick<Pool, 'query'>) {
  const pending = await pool.query(`SELECT 1 FROM access.admission WHERE action IN
    ('verification.claim-create','verification.claim-assess') AND state <> 'sealed' LIMIT 1`);
  if (pending.rowCount)
    throw new ClaimStatementFoldUnavailable(
      'Claim fold found pending verification admissions after closure; owned fences retained',
    );
}
async function terminal(
  env: WorkActivationEnvironment,
  receipt: string,
  digest: string,
  prepared?: PreparedClaimStatementFold,
) {
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?digest ?claim ?source ?revision ?template WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Succeeded ; rv:requestDigest ?digest .
      OPTIONAL { ${iri(receipt)} rv:convertedClaim ?claim ; rv:sourceClaimRevision ?source ; rv:statementRevision ?revision ;
        rv:claimFoldTemplateDigest ?template } } } LIMIT 2`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      )
    ).results?.bindings ?? [];
  if (!rows.length) return null;
  if (
    rows.length !== 1 ||
    rows[0]?.digest?.value !== digest ||
    (prepared &&
      (rows[0].claim?.value !== prepared.claim ||
        rows[0].source?.value !== prepared.claimRevision ||
        rows[0].revision?.value !== prepared.statementRevision))
  ) {
    throw new ClaimStatementFoldUnavailable('Claim fold receipt differs');
  }
  return rows[0]!;
}

export async function executeClaimStatementFold(
  env: WorkActivationEnvironment,
  prepared: PreparedClaimStatementFold,
  fence: ClaimStatementFoldFence,
  pool?: Pick<Pool, 'query'>,
  deadline = performance.now() + CLAIM_STATEMENT_FOLD_COST.deadlineMs,
) {
  for (const key of [
    'relationManifest',
    'relationPayload',
    'qualificationManifest',
    'qualificationPayload',
    'statementManifest',
    'statementPayload',
  ] as const)
    assertClaimFoldCustodyText(prepared.sealedBytes[key]);
  if (
    !pool ||
    (await pool.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id')).rows[0]
      ?.open !== false
  ) {
    throw new ClaimStatementFoldUnavailable('Claim fold requires its closed Access writer fence');
  }
  const command = envelope(env, 'convert', fence, [
    prepared.claim,
    prepared.claimRevision,
    prepared.statementRevision,
    prepared.sourceDigest,
  ]);
  await ownFence(env, fence);
  await assertClaimFoldAdmissionsDrained(pool);
  const update = `PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} { ${prepared.historicalCurrent} } }
    INSERT { GRAPH ${iri(GRAPHS.current)} { ${prepared.current} }
      GRAPH ${iri(GRAPHS.revisions)} { ${prepared.historicalCurrent}\n${prepared.revisions} }
      GRAPH ${iri(GRAPHS.receipts)} { ${command.facts}
        ${iri(command.receipt)} rv:convertedClaim ${iri(prepared.claim)} ; rv:sourceClaimRevision ${iri(prepared.claimRevision)} ;
        rv:statementRevision ${iri(prepared.statementRevision)} ; rv:relationDefinition ${iri(prepared.relationDefinition)} ;
        rv:qualificationDefinition ${iri(prepared.qualificationDefinition)} ; rv:sourceDigest ${lit(prepared.sourceDigest)} ;
        rv:claimFoldRelationManifest ${lit(prepared.sealedBytes.relationManifest)} ;
        rv:claimFoldRelationPayload ${lit(prepared.sealedBytes.relationPayload)} ;
        rv:claimFoldQualificationManifest ${lit(prepared.sealedBytes.qualificationManifest)} ;
        rv:claimFoldQualificationPayload ${lit(prepared.sealedBytes.qualificationPayload)} ;
        rv:claimFoldStatementManifest ${lit(prepared.sealedBytes.statementManifest)} ;
        rv:claimFoldStatementPayload ${lit(prepared.sealedBytes.statementPayload)} . }
    } WHERE { GRAPH ${iri(GRAPHS.control)} { ${command.control} ${iri(DATASET)} rv:restoreHold true .
      ${iri(fence.marker)} rv:claimStatementFoldFence true ; rv:foldMapDigest ${lit(fence.mapDigest)} . }
      ${prepared.sourceGuard} ${prepared.definitionGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(command.receipt)} ?rp ?ro } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(prepared.statementRevision)} ?bp ?bo } }
    }`;
  const template = hash(update);
  const existing = await terminal(env, command.receipt, command.digest, prepared);
  if (existing) {
    if (existing.template?.value !== template)
      throw new ClaimStatementFoldUnavailable('Claim fold template differs from receipt');
    return {
      status: 'replayed' as const,
      claim: prepared.claim,
      claimRevision: prepared.claimRevision,
      statementRevision: prepared.statementRevision,
      receipt: command.receipt,
    };
  }
  let outcome:
    | Awaited<ReturnType<WorkActivationEnvironment['fuseki']['commandWithReceipt']>>
    | undefined;
  if (performance.now() >= deadline || fusekiReadBudget.getStore()?.signal.aborted) {
    throw new ClaimStatementFoldBudgetExpired('Claim fold turn deadline expired');
  }
  try {
    outcome = await env.fuseki.commandWithReceipt({
      receipt: command.receipt,
      digest: command.digest,
      update,
      validations: prepared.validations,
      deadlineMs: Math.max(1, Math.floor(deadline - performance.now())),
    });
  } catch {
    /* resolve only through its exact receipt */
  }
  const committed = await terminal(env, command.receipt, command.digest, prepared);
  if (committed?.template?.value === template)
    return {
      status: 'converted' as const,
      claim: prepared.claim,
      claimRevision: prepared.claimRevision,
      statementRevision: prepared.statementRevision,
      receipt: command.receipt,
    };
  if (outcome?.status === 'invalid')
    throw new ClaimStatementFoldNativeHookRequired(
      'Native Claim-to-Statement fold policy is required',
    );
  if (outcome?.status === 'guard-unmatched')
    throw new ClaimStatementFoldStale('Claim head or reviewed definition changed');
  throw new ClaimStatementFoldUnavailable(
    'Claim fold outcome requires exact receipt reconciliation',
  );
}

async function replayTarget(
  env: WorkActivationEnvironment,
  input: ClaimStatementFoldInput,
  fence: ClaimStatementFoldFence,
) {
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?receipt ?revision ?sourceDigest ?digest ?template WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:commandFamily ${lit('claim-statement-fold-convert-v1')} ; rv:claimStatementFold ${iri(fence.marker)} ;
      rv:foldMapDigest ${lit(fence.mapDigest)} ; rv:convertedClaim ${iri(input.claim)} ;
      rv:sourceClaimRevision ${iri(input.claimRevision)} ; rv:statementRevision ?revision ;
      rv:relationDefinition ${iri(input.relationDefinition)} ; rv:qualificationDefinition ${iri(input.qualificationDefinition)} ;
      rv:sourceDigest ?sourceDigest ; rv:requestDigest ?digest ; rv:claimFoldTemplateDigest ?template . }
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.claim)} a <${RDF}Statement> ; rv:retainedClaimHead ${iri(input.claimRevision)} }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:StatementRevision ; rv:component ${iri(input.claim)} ;
      rv:retainedSourceRevision ${iri(input.claimRevision)} }
  } LIMIT 2`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      )
    ).results?.bindings ?? [];
  if (!rows.length) return null;
  if (
    rows.length !== 1 ||
    !/^[0-9a-f]{64}$/.test(rows[0]?.sourceDigest?.value ?? '') ||
    !/^[0-9a-f]{64}$/.test(rows[0]?.template?.value ?? '')
  )
    throw new ClaimStatementFoldUnavailable('Claim fold target replay is ambiguous');
  const row = rows[0]!;
  const proof = envelope(env, 'convert', fence, [
    input.claim,
    input.claimRevision,
    row.revision!.value,
    row.sourceDigest!.value,
  ]);
  if (row.receipt?.value !== proof.receipt || row.digest?.value !== proof.digest)
    throw new ClaimStatementFoldUnavailable('Claim fold target replay differs');
  return {
    status: 'replayed' as const,
    claim: input.claim,
    claimRevision: input.claimRevision,
    statementRevision: row.revision!.value,
    receipt: proof.receipt,
  };
}

/** Explicit reviewed targets only: bounded partial work never certifies a population inventory. */
export async function convertEligibleClaimsTurn(
  env: WorkActivationEnvironment,
  pool: Pool,
  input: ClaimStatementFoldMap & {
    job: string;
    claims: readonly { claim: string; claimRevision: string }[];
  },
) {
  return fusekiReadBudget.run(
    {
      signal: AbortSignal.timeout(CLAIM_STATEMENT_FOLD_COST.deadlineMs),
      callsLeft: CLAIM_STATEMENT_FOLD_COST.claims * 16 + 16,
      bytesLeft: CLAIM_STATEMENT_FOLD_COST.responseBytes * CLAIM_STATEMENT_FOLD_COST.claims,
    },
    () =>
      convertEligibleClaimsTurnAtBudget(
        env,
        pool,
        input,
        performance.now() + CLAIM_STATEMENT_FOLD_COST.deadlineMs,
      ),
  );
}

/** Acquire or resume this job's owned graph hold and closed Access writer fence, then recheck drained admissions. */
async function acquireClaimFoldFence(
  env: WorkActivationEnvironment,
  pool: Pool,
  input: ClaimStatementFoldMap,
  fence: ClaimStatementFoldFence,
  deadline: number,
) {
  const graphHeld =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:restoreHold true } }`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      )
    ).boolean === true;
  const owned =
    graphHeld &&
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(fence.marker)} rv:claimStatementFoldFence true ; rv:foldMapDigest ${lit(fence.mapDigest)} } }`,
        CLAIM_STATEMENT_FOLD_COST.responseBytes,
      )
    ).boolean === true;
  const access = await pool.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id',
  );
  if ((graphHeld && !owned) || (!graphHeld && access.rows[0]?.open !== true)) {
    throw new ClaimStatementFoldUnavailable(
      'Complete the original restore before Claim folding; unrelated fences cannot be borrowed',
    );
  }
  if (owned && access.rows[0]?.open !== false) {
    const acquire = envelope(env, 'acquire', fence);
    if (access.rows[0]?.open !== true || !(await terminal(env, acquire.receipt, acquire.digest)))
      throw new ClaimStatementFoldUnavailable('Claim fold Access fence is not closed');
    // Resume the graph/SQL fence boundary after a crash, only for this exact acquired job.
    await closeAccessFence(pool, deadline);
  }
  if (!owned) {
    // Never stop writers for an unreviewed or unavailable meaning binding.
    await validateRetainedClaimStatementDefinitions(
      env,
      input,
      undefined,
      async (sourceEnv, manifest, component, profile) =>
        (await readClaimFoldCustody(sourceEnv, manifest, component, profile)).state,
    );
    if (
      (
        await pool.query(`SELECT 1 FROM access.admission WHERE action IN
      ('verification.claim-create','verification.claim-assess') AND state <> 'sealed' LIMIT 1`)
      ).rowCount
    ) {
      throw new ClaimStatementFoldUnavailable(
        'Settle legacy verification admissions and owner effects before Claim folding',
      );
    }
    const acquire = envelope(env, 'acquire', fence);
    const update = `PREFIX rv: <${RV}> INSERT { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true . ${iri(fence.marker)} rv:claimStatementFoldFence true ; rv:foldMapDigest ${lit(fence.mapDigest)} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${acquire.facts} } } WHERE { GRAPH ${iri(GRAPHS.control)} { ${acquire.control} }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(acquire.receipt)} ?p ?o } } }`;
    let outcome:
      | Awaited<ReturnType<WorkActivationEnvironment['fuseki']['commandWithReceipt']>>
      | undefined;
    try {
      outcome = await env.fuseki.commandWithReceipt({
        receipt: acquire.receipt,
        digest: acquire.digest,
        update,
        validations: [],
        deadlineMs: Math.max(1, Math.floor(deadline - performance.now())),
      });
    } catch {
      /* resolve a lost acquire acknowledgement through its exact receipt */
    }
    if (outcome?.status === 'invalid')
      throw new ClaimStatementFoldNativeHookRequired(
        'Native owned Claim fold fence policy is required',
      );
    if (outcome?.status !== 'committed' && !(await terminal(env, acquire.receipt, acquire.digest)))
      throw new ClaimStatementFoldUnavailable('Claim fold fence could not be acquired');
    await ownFence(env, fence);
    await closeAccessFence(pool, deadline);
  }
  await ownFence(env, fence);
  // Closure waits for in-flight Access transactions; the pre-acquire check alone cannot prove this cut.
  await assertClaimFoldAdmissionsDrained(pool);
}

async function convertEligibleClaimsTurnAtBudget(
  env: WorkActivationEnvironment,
  pool: Pool,
  input: ClaimStatementFoldMap & {
    job: string;
    claims: readonly { claim: string; claimRevision: string }[];
  },
  deadline: number,
) {
  if (
    input.claims.length > CLAIM_STATEMENT_FOLD_COST.claims ||
    new Set(input.claims.map((item) => item.claim)).size !== input.claims.length
  ) {
    throw new ClaimStatementFoldUnavailable('Claim fold turn exceeds its explicit target bound');
  }
  const fence = claimStatementFoldFence(env, input, input.job);
  await acquireClaimFoldFence(env, pool, input, fence, deadline);
  const converted: Awaited<ReturnType<typeof executeClaimStatementFold>>[] = [];
  const retained: { claim: string; reason: string }[] = [];
  for (let index = 0; index < input.claims.length; index++) {
    if (performance.now() >= deadline || fusekiReadBudget.getStore()?.signal.aborted) {
      return {
        status: 'partial' as const,
        complete: false as const,
        scope: 'explicit-targets' as const,
        fence,
        converted,
        retained,
        reason: 'budget-expired' as const,
        remaining: input.claims.slice(index),
      };
    }
    const item = input.claims[index]!;
    try {
      const target = {
        ...item,
        relationDefinition: input.relationDefinition,
        qualificationDefinition: input.qualificationDefinition,
      };
      const replayed = await replayTarget(env, target, fence);
      const preparation = replayed ? null : await prepareClaimStatementFold(env, target);
      if (preparation?.status === 'retained')
        retained.push({ claim: preparation.claim, reason: preparation.reason });
      else {
        const result =
          replayed ??
          (await executeClaimStatementFold(
            env,
            (preparation as { status: 'eligible'; prepared: PreparedClaimStatementFold }).prepared,
            fence,
            pool,
            deadline,
          ));
        // Loading seek during owner discovery re-enters its top-level outbox handler imports.
        const { StatementSeek } = await import('../statement/seek.ts');
        await new StatementSeek(pool, env).projectClaimFold(
          result.claim,
          result.statementRevision,
          fence.marker,
          fence.mapDigest,
          deadline,
        );
        converted.push(result);
      }
    } catch (error) {
      if (
        error instanceof ClaimStatementFoldBudgetExpired ||
        fusekiReadBudget.getStore()?.signal.aborted
      ) {
        return {
          status: 'partial' as const,
          complete: false as const,
          scope: 'explicit-targets' as const,
          fence,
          converted,
          retained,
          reason: 'budget-expired' as const,
          remaining: input.claims.slice(index),
        };
      }
      throw error;
    }
  }
  return {
    status: 'partial' as const,
    complete: false as const,
    scope: 'explicit-targets' as const,
    fence,
    converted,
    retained,
    remaining: [],
  };
}

// ------------------------------------------------------------ original inventory

export const CLAIM_FOLD_ORIGINAL_INVENTORY_COST = {
  auditWindows: 4,
  inventoryPages: 16,
  memberPages: 16,
  deadlineMs: 30_000,
  /** One wall-clock attempt window. Native work still bounds each page to 30 seconds. */
  attemptMs: 60 * 60 * 1000,
} as const;

/** Fixed native maintenance DTOs. The transport adds only capability, size and budget handling. */
export interface ClaimFoldInventoryJob {
  dataEpoch: string;
  routingEpoch: string;
  marker: string;
  mapDigest: string;
  job: string;
  acquireReceipt: string;
}
export interface ClaimFoldInventoryRow {
  claim: string;
  head: string;
  witness: string;
}
export interface ClaimFoldInventoryRequest {
  job: ClaimFoldInventoryJob;
  attempt: string;
  page: number;
  previous: string;
  requestId: string;
  deadline: number;
}
export interface ClaimFoldInventoryPage {
  status: string;
  sourceComplete?: boolean;
  attempt?: string;
  page?: number;
  next?: string;
  hash?: string;
  total?: number;
  rows?: ClaimFoldInventoryRow[];
  sourceCut?: string;
  error?: string;
}
export interface ClaimFoldMembersRequest {
  job: ClaimFoldInventoryJob;
  sourceCut: string;
  seal: string;
  progress: string;
  deadline: number;
}
export interface ClaimFoldMembersPage {
  status: string;
  directoryEOF?: boolean;
  sourceCut?: string;
  seal?: string;
  count?: number;
  rows?: ClaimFoldInventoryRow[];
  progress?: string;
  error?: string;
}
export interface ClaimFoldMaintenanceTransport {
  claimFoldInventory(
    request: ClaimFoldInventoryRequest,
    signal?: AbortSignal,
  ): Promise<ClaimFoldInventoryPage>;
  claimFoldMembers(
    request: ClaimFoldMembersRequest,
    signal?: AbortSignal,
  ): Promise<ClaimFoldMembersPage>;
}

/** Unsigned working state. Only a signed copy ever leaves or re-enters a turn. */
export interface ClaimFoldOriginalInventoryState {
  marker: string;
  accessGeneration: string;
  content: { job: string; generation: string; restoreEpoch: string };
  audit: {
    cursor: AssessmentHistoryCursor | null;
    done: boolean;
    windows: number;
    entries: number;
    counts: Record<string, number>;
    digest: string;
  };
  inventory: {
    attempt: string;
    deadline: number;
    page: number;
    previous: string;
    total: number;
    sourceCut: string | null;
    seal: string | null;
    sealed: boolean;
    accumulator: string;
  };
  members: { progress: string; count: number; accumulator: string; done: boolean };
}
/** The state authenticated by a domain-separated HMAC under the service maintenance capability. */
export type ClaimFoldOriginalInventoryProgress = ClaimFoldOriginalInventoryState & { mac: string };
export interface ClaimFoldOriginalInventoryInput extends ClaimStatementFoldMap {
  job: string;
  transport: ClaimFoldMaintenanceTransport;
  contentPool: Pool;
  store: VerificationStore;
  /** A permit from the existing maintenance closure of Content1704; this turn never closes it. */
  permit: AssessmentProducerPermit;
  /** The service maintenance capability from composition. Keys progress authenticity; never persisted or sent. */
  maintenanceCapability: string;
  progress?: ClaimFoldOriginalInventoryProgress;
}
/** What a captured original population still does not establish. Nothing here is closure or release. */
export const CLAIM_FOLD_ORIGINAL_LINKAGE = {
  creatorAcknowledgement: 'unresolved',
  evidenceToRevision: 'unresolved',
  retainedBodyCustody: 'unresolved',
  seekReconciliation: 'unresolved',
} as const;
export type ClaimFoldOriginalInventoryTurn =
  | {
      status: 'partial';
      complete: false;
      release: 'denied';
      reason: 'turn-bound' | 'budget-expired' | 'retry-exact-request';
      progress: ClaimFoldOriginalInventoryProgress;
    }
  | {
      status: 'captured';
      complete: false;
      release: 'denied';
      progress: ClaimFoldOriginalInventoryProgress;
      original: {
        job: ClaimFoldInventoryJob;
        attempt: string;
        sourceCut: string;
        seal: string;
        total: number;
        directory: { count: number; accumulator: string };
        access: { generation: string };
        content: { job: string; generation: string; restoreEpoch: string };
        assessmentHistory: {
          windows: number;
          entries: number;
          counts: Record<string, number>;
          digest: string;
        };
        linkage: typeof CLAIM_FOLD_ORIGINAL_LINKAGE;
      };
    };

const NATIVE_ID = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ZERO64 = '0'.repeat(64);
const INVENTORY_ROWS = 127;

const memberHash = (row: ClaimFoldInventoryRow) =>
  hash(`${row.claim}\n${row.head}\n${row.witness}`);
const xorHex = (left: string, right: string) => {
  const a = Buffer.from(left, 'hex'),
    b = Buffer.from(right, 'hex');
  return Buffer.from(a.map((byte, index) => byte ^ b[index]!)).toString('hex');
};
/** The same request must reproduce the same identity after a lost acknowledgement. */
const inventoryRequestId = (
  job: ClaimFoldInventoryJob,
  attempt: string,
  page: number,
  previous: string,
) => {
  const digest = createHash('sha256')
    .update(JSON.stringify(['claim-fold-inventory-request-v1', job, attempt, page, previous]))
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
function checkedRows(value: unknown): ClaimFoldInventoryRow[] {
  if (!Array.isArray(value) || value.length > INVENTORY_ROWS)
    throw new ClaimStatementFoldUnavailable('Claim inventory rows exceed their native bound');
  const claims = new Set<string>();
  return value.map((row: unknown) => {
    const item = row as Record<string, unknown> | null;
    if (
      !item ||
      Object.keys(item).sort().join() !== 'claim,head,witness' ||
      typeof item.claim !== 'string' ||
      !NATIVE_ID.test(item.claim) ||
      typeof item.head !== 'string' ||
      !NATIVE_ID.test(item.head) ||
      typeof item.witness !== 'string' ||
      !HEX64.test(item.witness) ||
      claims.has(item.claim)
    )
      throw new ClaimStatementFoldUnavailable('Claim inventory row differs from its fixed shape');
    claims.add(item.claim);
    return { claim: item.claim, head: item.head, witness: item.witness };
  });
}

async function closedAccessGeneration(pool: Pick<Pool, 'query'>) {
  const fence = (
    await pool.query<{ open: boolean; generation: string }>(
      'SELECT open, generation::text AS generation FROM access.recovery_fence WHERE id',
    )
  ).rows[0];
  if (fence?.open !== false)
    throw new ClaimStatementFoldUnavailable(
      'Claim inventory requires its closed Access generation',
    );
  return fence.generation;
}

/** Borrow one client per owner for a single read-only transaction each: Access first, then Content. */
async function withOwnerSnapshots<T>(
  pool: Pool,
  contentPool: Pool,
  work: (access: PoolClient, content: PoolClient) => Promise<T>,
): Promise<T> {
  const access = await pool.connect();
  try {
    const content = await contentPool.connect();
    try {
      await access.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await content.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      return await work(access, content);
    } finally {
      await content.query('ROLLBACK').catch(() => undefined);
      content.release();
    }
  } finally {
    await access.query('ROLLBACK').catch(() => undefined);
    access.release();
  }
}

const PROGRESS_DOMAIN = 'rezics:claim-fold-original-inventory-progress:v1';
const PROGRESS_BYTES = 16 * 1024;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const UUID_TEXT = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
function progressKey(input: ClaimFoldOriginalInventoryInput) {
  const capability = input.maintenanceCapability;
  if (typeof capability !== 'string' || !HEX64.test(capability))
    throw new ClaimStatementFoldUnavailable(
      'Claim inventory progress needs the maintenance capability',
    );
  return Buffer.from(capability, 'hex');
}
/** Job, fence, reviewed D/Q (through the map digest) and lineage are fixed by the caller's input. */
const progressBinding = (job: ClaimFoldInventoryJob) => [
  job.dataEpoch,
  job.routingEpoch,
  job.marker,
  job.mapDigest,
  job.job,
];
const progressMac = (
  key: Buffer,
  job: ClaimFoldInventoryJob,
  state: ClaimFoldOriginalInventoryState,
) =>
  createHmac('sha256', key)
    .update(`${PROGRESS_DOMAIN}\0${canonicalJson([progressBinding(job), state])}`)
    .digest('hex');
const signProgress = (
  key: Buffer,
  job: ClaimFoldInventoryJob,
  state: ClaimFoldOriginalInventoryState,
): ClaimFoldOriginalInventoryProgress => ({
  ...structuredClone(state),
  mac: progressMac(key, job, state),
});
const forged = () =>
  new ClaimStatementFoldUnavailable('Claim inventory progress is not authentic for this job');

/** Exact schema, sizes and invariants of unauthenticated caller bytes; unknown fields are refused. */
function checkedProgress(value: unknown): ClaimFoldOriginalInventoryProgress {
  const object = (item: unknown, keys: string): Record<string, unknown> => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join() !== keys
    )
      throw forged();
    return item as Record<string, unknown>;
  };
  const text = (item: unknown, pattern: RegExp, max = 4096) => {
    if (typeof item !== 'string' || item.length > max || !pattern.test(item)) throw forged();
    return item;
  };
  const count = (item: unknown) => {
    if (!Number.isSafeInteger(item) || (item as number) < 0) throw forged();
    return item as number;
  };
  const flag = (item: unknown) => {
    if (typeof item !== 'boolean') throw forged();
    return item;
  };
  try {
    if (Buffer.byteLength(JSON.stringify(value) ?? '') > PROGRESS_BYTES) throw forged();
  } catch {
    throw forged();
  }
  const root = object(value, 'accessGeneration,audit,content,inventory,mac,marker,members');
  const content = object(root.content, 'generation,job,restoreEpoch');
  const audit = object(root.audit, 'counts,cursor,digest,done,entries,windows');
  const cursor =
    audit.cursor === null
      ? null
      : (() => {
          const item = object(audit.cursor, 'after,recoveryGeneration');
          return {
            after: text(item.after, UUID_TEXT, 36),
            recoveryGeneration: text(item.recoveryGeneration, DECIMAL, 20),
          };
        })();
  const rawCounts = audit.counts;
  if (
    !rawCounts ||
    typeof rawCounts !== 'object' ||
    Array.isArray(rawCounts) ||
    Object.keys(rawCounts).length > 64
  )
    throw forged();
  const counts = Object.fromEntries(
    Object.entries(rawCounts).map(([key, item]) => [text(key, /^[a-z:-]{1,80}$/, 80), count(item)]),
  );
  const inventory = object(
    root.inventory,
    'accumulator,attempt,deadline,page,previous,seal,sealed,sourceCut,total',
  );
  const members = object(root.members, 'accumulator,count,done,progress');
  const hexOrNull = (item: unknown) => (item === null ? null : text(item, HEX64, 64));
  const state: ClaimFoldOriginalInventoryState = {
    marker: text(root.marker, /^urn:rezics:maintenance:claim-statement-fold:[0-9a-f]{64}$/, 200),
    accessGeneration: text(root.accessGeneration, DECIMAL, 20),
    content: {
      job: text(content.job, /^[A-Za-z0-9:_-]{1,128}$/, 128),
      generation: text(content.generation, DECIMAL, 20),
      restoreEpoch: text(content.restoreEpoch, DECIMAL, 20),
    },
    audit: {
      cursor,
      done: flag(audit.done),
      windows: count(audit.windows),
      entries: count(audit.entries),
      counts,
      digest: text(audit.digest, HEX64, 64),
    },
    inventory: {
      attempt: text(inventory.attempt, UUID_TEXT, 36),
      deadline: count(inventory.deadline),
      page: count(inventory.page),
      previous: text(inventory.previous, /^(?:[0-9a-f]{64})?$/, 64),
      total: count(inventory.total),
      sourceCut: hexOrNull(inventory.sourceCut),
      seal: hexOrNull(inventory.seal),
      sealed: flag(inventory.sealed),
      accumulator: text(inventory.accumulator, HEX64, 64),
    },
    members: {
      progress: text(members.progress, /^[A-Za-z0-9_.-]*$/, 4096),
      count: count(members.count),
      accumulator: text(members.accumulator, HEX64, 64),
      done: flag(members.done),
    },
  };
  // Each phase can only have advanced behind its predecessor.
  if (
    state.inventory.sealed !== (state.inventory.seal !== null) ||
    (state.inventory.sealed && state.inventory.sourceCut === null) ||
    (state.audit.done && state.audit.cursor !== null) ||
    (state.inventory.page > 0 && !state.audit.done) ||
    (state.members.done && !state.inventory.sealed) ||
    (state.members.count > 0 && !state.inventory.sealed)
  )
    throw forged();
  return { ...state, mac: text(root.mac, HEX64, 64) };
}

/** Re-prove the closed Access generation, drained admissions and exact Content1704 permit. */
async function recheckOwnerCuts(
  pool: Pool,
  input: ClaimFoldOriginalInventoryInput,
  progress: ClaimFoldOriginalInventoryState,
) {
  if ((await closedAccessGeneration(pool)) !== progress.accessGeneration)
    throw new ClaimStatementFoldStale('Claim inventory Access generation changed');
  await assertClaimFoldAdmissionsDrained(pool);
  await withOwnerSnapshots(pool, input.contentPool, async (_access, content) => {
    await input.store.readAssessmentProducerOriginals(content, input.permit, []);
  });
}

/**
 * Capture the ORIGINAL native Claim inventory before any conversion, under the
 * closed Access generation and the closed Content1704 permit, and join it to a
 * read-only audit of the retained assessment history. The result is evidence
 * only: creator acknowledgement, E to R, retained body custody and seek
 * reconciliation stay unresolved and no completion or release is granted.
 * A lost page acknowledgement is retried with the identical request.
 */
export async function receiveClaimFoldOriginalInventoryTurn(
  env: WorkActivationEnvironment,
  pool: Pool,
  input: ClaimFoldOriginalInventoryInput,
): Promise<ClaimFoldOriginalInventoryTurn> {
  const cost = CLAIM_FOLD_ORIGINAL_INVENTORY_COST;
  return fusekiReadBudget.run(
    {
      signal: AbortSignal.timeout(cost.deadlineMs),
      callsLeft:
        cost.auditWindows * ASSESSMENT_HISTORY_AUDIT_COST.nativeCalls +
        cost.inventoryPages +
        cost.memberPages +
        16,
      bytesLeft:
        cost.auditWindows * ASSESSMENT_HISTORY_AUDIT_COST.nativeBytes +
        (cost.inventoryPages + cost.memberPages) * 512 * 1024,
    },
    () => receiveAtBudget(env, pool, input, performance.now() + cost.deadlineMs),
  );
}

async function receiveAtBudget(
  env: WorkActivationEnvironment,
  pool: Pool,
  input: ClaimFoldOriginalInventoryInput,
  deadline: number,
): Promise<ClaimFoldOriginalInventoryTurn> {
  const cost = CLAIM_FOLD_ORIGINAL_INVENTORY_COST;
  const fence = claimStatementFoldFence(env, input, input.job);
  const acquire = envelope(env, 'acquire', fence);
  const job: ClaimFoldInventoryJob = {
    dataEpoch: env.lineage.dataEpoch,
    routingEpoch: env.lineage.routingEpoch,
    marker: fence.marker,
    mapDigest: fence.mapDigest,
    job: fence.job,
    acquireReceipt: acquire.receipt,
  };
  const permit = input.permit;
  if (permit.mode !== 'maintenance' || typeof permit.job !== 'string')
    throw new ClaimStatementFoldUnavailable(
      'Claim inventory requires the closed Content1704 permit',
    );
  // Cached cursors, flags, counts and digests are trusted only after this check, before any side effect.
  const key = progressKey(input);
  let supplied: ClaimFoldOriginalInventoryState | undefined;
  if (input.progress !== undefined) {
    const { mac, ...rest } = checkedProgress(input.progress);
    const expected = Buffer.from(progressMac(key, job, rest), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(mac, 'hex'))) throw forged();
    supplied = rest;
  }
  await acquireClaimFoldFence(env, pool, input, fence, deadline);
  const generation = await closedAccessGeneration(pool);
  const content = {
    job: permit.job,
    generation: permit.generation,
    restoreEpoch: permit.restoreEpoch,
  };
  let progress: ClaimFoldOriginalInventoryState = structuredClone(
    supplied ?? {
      marker: fence.marker,
      accessGeneration: generation,
      content,
      audit: { cursor: null, done: false, windows: 0, entries: 0, counts: {}, digest: ZERO64 },
      inventory: {
        attempt: randomUUID(),
        deadline: Date.now() + cost.attemptMs,
        page: 0,
        previous: '',
        total: 0,
        sourceCut: null,
        seal: null,
        sealed: false,
        accumulator: ZERO64,
      },
      members: { progress: '', count: 0, accumulator: ZERO64, done: false },
    },
  );
  if (
    progress.marker !== fence.marker ||
    progress.accessGeneration !== generation ||
    JSON.stringify(progress.content) !== JSON.stringify(content)
  )
    throw new ClaimStatementFoldStale('Claim inventory progress belongs to another cut');
  await recheckOwnerCuts(pool, input, progress);
  const signal = fusekiReadBudget.getStore()!.signal;
  const expired = () => performance.now() >= deadline || signal.aborted;
  const partial = (
    reason: 'turn-bound' | 'budget-expired' | 'retry-exact-request',
  ): ClaimFoldOriginalInventoryTurn => ({
    status: 'partial',
    complete: false,
    release: 'denied',
    reason,
    progress: signProgress(key, job, progress),
  });
  // The first owner reads are awaited before any phase starts; none may finish past the one deadline.
  if (expired()) return partial('budget-expired');
  // Original assessment history first: unresolved entries are counted, never repaired.
  for (let windows = 0; !progress.audit.done; windows++) {
    if (windows >= cost.auditWindows) return partial('turn-bound');
    if (expired()) return partial('budget-expired');
    const page = await withOwnerSnapshots(pool, input.contentPool, (access, contentClient) =>
      auditAssessmentHistoryWindow(
        { env, store: input.store },
        {
          access,
          content: contentClient,
          permit,
          history: progress.audit.cursor
            ? { cursor: progress.audit.cursor }
            : { recoveryGeneration: progress.accessGeneration },
        },
      ),
    );
    if (
      page.access.cut.state !== 'held' ||
      page.access.cut.recoveryGeneration !== progress.accessGeneration
    )
      throw new ClaimStatementFoldStale('Claim inventory Access history cut is not held');
    const counts = { ...progress.audit.counts };
    for (const entry of page.entries) {
      const outcome = entry.outcome;
      const key = outcome.status === 'unresolved' ? `unresolved:${outcome.reason}` : outcome.status;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    progress.audit = {
      cursor: page.access.next,
      done: page.access.next === null,
      windows: progress.audit.windows + 1,
      entries: progress.audit.entries + page.entries.length,
      counts,
      digest: hash(`${progress.audit.digest}\n${JSON.stringify(page.entries)}`),
    };
  }
  // Original native population: the exact request is reissued until its response is validated.
  for (let pages = 0; !progress.inventory.sealed; pages++) {
    if (pages >= cost.inventoryPages) return partial('turn-bound');
    if (expired()) return partial('budget-expired');
    const state = progress.inventory;
    const request: ClaimFoldInventoryRequest = {
      job,
      attempt: state.attempt,
      page: state.page,
      previous: state.previous,
      requestId: inventoryRequestId(job, state.attempt, state.page, state.previous),
      deadline: state.deadline,
    };
    let result: ClaimFoldInventoryPage;
    try {
      result = await input.transport.claimFoldInventory(request, signal);
    } catch {
      return partial('retry-exact-request');
    }
    if (result.status === 'deadline' && Date.now() < state.deadline)
      return partial('retry-exact-request');
    if (result.status !== 'committed')
      throw new ClaimStatementFoldUnavailable(
        `Claim inventory ${result.status}: ${result.error ?? 'refused'}; begin a new attempt only before conversion`,
      );
    const rows = checkedRows(result.rows);
    if (
      result.attempt !== state.attempt ||
      result.page !== state.page ||
      typeof result.hash !== 'string' ||
      !HEX64.test(result.hash) ||
      typeof result.sourceCut !== 'string' ||
      !HEX64.test(result.sourceCut) ||
      (state.sourceCut !== null && result.sourceCut !== state.sourceCut) ||
      typeof result.sourceComplete !== 'boolean' ||
      typeof result.next !== 'string' ||
      !/^(?:[0-9a-f]{64})?$/.test(result.next) ||
      result.total !== state.total + rows.length
    )
      throw new ClaimStatementFoldUnavailable(
        'Claim inventory page differs from its exact request',
      );
    progress.inventory = {
      ...state,
      page: state.page + 1,
      previous: result.hash,
      total: result.total,
      sourceCut: result.sourceCut,
      seal: result.sourceComplete ? result.hash : null,
      sealed: result.sourceComplete,
      accumulator: rows.reduce((value, row) => xorHex(value, memberHash(row)), state.accumulator),
    };
  }
  const sealed = progress.inventory;
  // The native directory must enumerate exactly the pages this receiver saw.
  for (let pages = 0; !progress.members.done; pages++) {
    if (pages >= cost.memberPages) return partial('turn-bound');
    if (expired()) return partial('budget-expired');
    const state = progress.members;
    let result: ClaimFoldMembersPage;
    try {
      result = await input.transport.claimFoldMembers(
        {
          job,
          sourceCut: sealed.sourceCut!,
          seal: sealed.seal!,
          progress: state.progress,
          deadline: sealed.deadline,
        },
        signal,
      );
    } catch {
      return partial('retry-exact-request');
    }
    if (
      result.status === 'invalid' &&
      /not native authority/.test(result.error ?? '') &&
      state.progress
    ) {
      // Native progress is a process-local credential; restart the read-only directory scan.
      progress.members = { progress: '', count: 0, accumulator: ZERO64, done: false };
      continue;
    }
    if (result.status === 'deadline') return partial('retry-exact-request');
    if (result.status !== 'read')
      throw new ClaimStatementFoldUnavailable(
        `Claim member directory ${result.status}: ${result.error ?? 'refused'}`,
      );
    const rows = checkedRows(result.rows);
    const count = state.count + rows.length;
    if (
      result.sourceCut !== sealed.sourceCut ||
      result.seal !== sealed.seal ||
      result.count !== count ||
      typeof result.directoryEOF !== 'boolean' ||
      typeof result.progress !== 'string' ||
      (result.directoryEOF ? result.progress !== '' : result.progress === '')
    )
      throw new ClaimStatementFoldUnavailable(
        'Claim member directory differs from its exact request',
      );
    const accumulator = rows.reduce(
      (value, row) => xorHex(value, memberHash(row)),
      state.accumulator,
    );
    if (result.directoryEOF && (count !== sealed.total || accumulator !== sealed.accumulator))
      throw new ClaimStatementFoldUnavailable(
        'Claim member directory differs from the sealed inventory',
      );
    progress.members = {
      progress: result.progress,
      count,
      accumulator,
      done: result.directoryEOF,
    };
  }
  // A late producer, Access generation change or Content gate change after capture invalidates it.
  await ownFence(env, fence);
  await recheckOwnerCuts(pool, input, progress);
  // Awaited owner reads can outlive the turn: a capture is declared only inside its deadline.
  if (expired()) return partial('budget-expired');
  return {
    status: 'captured',
    complete: false,
    release: 'denied',
    progress: signProgress(key, job, progress),
    original: {
      job,
      attempt: sealed.attempt,
      sourceCut: sealed.sourceCut!,
      seal: sealed.seal!,
      total: sealed.total,
      directory: { count: progress.members.count, accumulator: progress.members.accumulator },
      access: { generation: progress.accessGeneration },
      content: progress.content,
      assessmentHistory: {
        windows: progress.audit.windows,
        entries: progress.audit.entries,
        counts: progress.audit.counts,
        digest: progress.audit.digest,
      },
      linkage: CLAIM_FOLD_ORIGINAL_LINKAGE,
    },
  };
}
