import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { ContextCommandUnavailable, InvalidContextCommand, checkedCommandReceipt,
  commandReceiptIri, commitCommand, readCommandReceipt, sealCommandTerminal, term } from '../context/command.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { objectTerm } from './graph.ts';
import { STATEMENT_DECISION_PROFILE, STATEMENT_PROFILE, convertV1ClassificationSlot,
  type V1ClassificationSlot } from './schema.ts';

export const MIGRATION_FAMILY = 'statement-migrate-v1';
export const CUTOVER_FAMILY = 'statement-cutover-v1';
export const DECISION_MODEL = 'https://rezics.com/vocab/StatementDecisions';
export const CUTOVER_PROFILE = 'https://rezics.com/definition/statement-cutover-v1';
export const MIGRATION_SCOPE = 'statement:migrate:root';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export function migrationRequest(application: string, expectedDecision: string, actingSubject: string) {
  if (![application, expectedDecision, actingSubject].every(value => nativeId.test(value))) {
    throw new InvalidContextCommand('invalid v1 migration request');
  }
  return { action: 'statement.migrate', scope: MIGRATION_SCOPE,
    digest: hash(JSON.stringify([MIGRATION_FAMILY, application, expectedDecision, actingSubject])) };
}

export function cutoverRequest(actingSubject: string) {
  if (!nativeId.test(actingSubject)) throw new InvalidContextCommand('invalid v1 cutover request');
  return { action: 'statement.cutover', scope: MIGRATION_SCOPE,
    digest: hash(JSON.stringify([CUTOVER_FAMILY, actingSubject])) };
}

/** The successful cutover receipt is the decision-model fence for writers and readers. */
export async function statementCutoverActive(env: WorkActivationEnvironment): Promise<boolean> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.receipts)} { ?cutover a rv:OperationReceipt ;
      rv:commandFamily ${lit(CUTOVER_FAMILY)} ; rv:outcome rv:Succeeded ;
      rv:decisionModel ${term(DECISION_MODEL)} . }
  }`);
  return result.boolean === true;
}

/** Install the one decision-model fence only when every retained current v1 head is converted. */
export async function cutoverV1Decisions(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  actingSubject: string) {
  const request = cutoverRequest(actingSubject);
  const existing = await readCommandReceipt(env, admission.id, CUTOVER_FAMILY);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const receipt = commandReceiptIri(admission.id, CUTOVER_FAMILY);
  const manifest = prepareComponent(env.objectDirectory, revision, {
    revision, decisionModel: DECISION_MODEL, recordedBy: actingSubject }, CUTOVER_PROFILE);
  const validations = await profileValidations(env.fuseki, 'statement-cutover-v1', [
    { shape: `${CUTOVER_PROFILE}/cutover-shape`, focus: [revision], graphs: [GRAPHS.revisions] },
  ]);
  const committed = await commitCommand(env, admission, { family: CUTOVER_FAMILY,
    digest: request.digest, validations, operation, component: DATASET, revision, expectedHead: null,
    insert: `GRAPH ${iri(GRAPHS.receipts)} {
      ${iri(receipt)} rv:decisionModel ${term(DECISION_MODEL)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StatementCutover, rv:RevisionAnchor ;
        rv:component ${iri(DATASET)} ; rv:recordedBy ${iri(actingSubject)} ;
        rv:operation ${iri(operation)} ; rv:modelRevision ${iri(CUTOVER_PROFILE)} ;
        rv:shapeRevision ${iri(CUTOVER_PROFILE)} ;
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next . }`,
    where: `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} {
      ?cutover a rv:OperationReceipt ; rv:commandFamily ${lit(CUTOVER_FAMILY)} ;
        rv:outcome rv:Succeeded ; rv:decisionModel ${term(DECISION_MODEL)} . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ?application a rv:ClassificationApplication ; rv:decisionHead ?old .
        FILTER NOT EXISTS { ?statement a rdf:Statement ; rv:migratedFrom ?application ;
          rv:meaningKey ?key . ?slot a rv:DecisionSlot ; rv:decisionTarget ?key .
          GRAPH ${iri(GRAPHS.revisions)} { ?new a rv:StatementDecision ;
            rv:component ?slot ; rv:convertedFrom ?old ;
              rv:support ?statement . } }
      } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  throw new ContextCommandUnavailable('v1 decisions remain unmigrated or cutover already completed');
}

/** Convert one exact current v1 head; retained v1 revisions and receipts are never rewritten. */
export async function migrateV1Decision(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: { application: string; expectedDecision: string; actingSubject: string }) {
  const request = migrationRequest(input.application, input.expectedDecision, input.actingSubject);
  const existing = await readCommandReceipt(env, admission.id, MIGRATION_FAMILY);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?main ?sense ?senseRevision ?concept ?context ?contextRevision ?proposer
      ?decision ?outcome ?basis ?decidedBy WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.application)} a rv:ClassificationApplication ; rv:applicationState rv:Active ;
        rv:applicationChannel rv:Curated ; rv:targetMainVersion ?main ; rv:sense ?sense ;
        rv:classificationContext ?context ; rv:proposer ?proposer ; rv:decisionHead ?decision .
      ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:head ?senseRevision ;
        rv:expression ?expression .
      ?expression a rv:ClassificationExpression ; rv:propositionKind rv:ConceptAssertion ;
        rv:expressionState rv:Active ; rv:assertedConcept ?concept .
      OPTIONAL { ?context rv:head ?contextRevision }
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?senseRevision a rv:RevisionAnchor ; rv:component ?sense ;
        rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} .
      ?decision a rv:ClassificationDecision, rv:RevisionAnchor ;
        rv:component ${iri(input.application)} ; rv:application ${iri(input.application)} ;
        rv:outcome ?outcome ; rv:decisionBasis ?basis ; rv:decidedBy ?decidedBy .
    }
  }`)).results?.bindings ?? [];
  if (rows.length !== 1) throw new ContextCommandUnavailable('v1 classification slot is unavailable');
  const row = rows[0]!;
  const value = (key: string) => row[key]?.value;
  if (value('decision') !== input.expectedDecision || !value('main') || !value('sense')
    || !value('senseRevision') || !value('concept') || !value('context') || !value('proposer')
    || !value('basis') || !value('decidedBy')) {
    throw new ContextCommandUnavailable('v1 classification slot changed or is incomplete');
  }
  const outcome = value('outcome') === `${RV}Accepted` ? 'accepted'
    : value('outcome') === `${RV}Rejected` ? 'rejected' : null;
  const basis = value('basis') === `${RV}GlobalCuratorReview` ? 'global-curator-review'
    : value('basis') === `${RV}RealmManagerReview` ? 'realm-manager-review' : null;
  if (!outcome || !basis) throw new ContextCommandUnavailable('v1 decision outcome is unavailable');
  const slot: V1ClassificationSlot = { application: input.application, mainVersion: value('main')!,
    senseRevision: value('senseRevision')!, concept: value('concept')!,
    acceptanceContext: value('context')!, contextRevision: value('contextRevision') ?? null,
    proposer: value('proposer')!, headDecision: value('decision')!, headOutcome: outcome,
    headBasis: basis, headDecidedBy: value('decidedBy')! };
  const converted = convertV1ClassificationSlot(slot, { statement: ID + Bun.randomUUIDv7(),
    statementRevision: ID + Bun.randomUUIDv7(), decision: ID + Bun.randomUUIDv7() });
  const { statement, decision } = converted;
  const decisionSlot = converted.slot;
  const operation = ID + Bun.randomUUIDv7();
  const statementManifest = prepareComponent(env.objectDirectory, statement.id, {
    revision: statement.head, meaning: { subject: statement.subject, predicate: statement.predicate,
      relationDefinition: statement.relationDefinition,
      interpretationDefinitions: statement.interpretationDefinitions, value: statement.value,
      applicability: statement.applicability }, meaningKey: statement.meaningKey,
    speaker: statement.speaker, semanticContextRevision: null, state: 'active',
    evidence: [], recordedBy: input.actingSubject, migratedFrom: input.application }, STATEMENT_PROFILE);
  const decisionManifest = prepareComponent(env.objectDirectory, decisionSlot.id, {
    decision: decision.id, target: decisionSlot.target, support: decision.support,
    acceptanceContext: decisionSlot.acceptanceContext, contextRevision: decision.contextRevision,
    predecessor: null, outcome: decision.outcome, basis: decision.basis,
    decidedBy: decision.decidedBy, convertedFrom: decision.convertedFrom }, STATEMENT_DECISION_PROFILE);
  const validations = await profileValidations(env.fuseki, 'statement-v1', [
    { shape: `${STATEMENT_PROFILE}/statement-shape`, focus: [statement.id],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${STATEMENT_PROFILE}/revision-shape`, focus: [statement.head],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  validations.push(...await profileValidations(env.fuseki, 'statement-decision-v1', [
    { shape: `${STATEMENT_DECISION_PROFILE}/slot-shape`, focus: [decisionSlot.id],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${STATEMENT_DECISION_PROFILE}/decision-shape`, focus: [decision.id],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]));
  const guard = `GRAPH ${iri(GRAPHS.current)} {
    ${iri(input.application)} a rv:ClassificationApplication ; rv:applicationState rv:Active ;
      rv:targetMainVersion ${iri(slot.mainVersion)} ; rv:classificationContext ${iri(slot.acceptanceContext)} ;
      rv:sense ${iri(value('sense')!)} ; rv:proposer ${iri(slot.proposer)} ;
      rv:decisionHead ${iri(slot.headDecision)} .
    ${iri(value('sense')!)} a rv:ClassificationSense ; rv:senseState rv:Active ;
      rv:head ${iri(slot.senseRevision)} ; rv:expression ?expression .
    ?expression a rv:ClassificationExpression ; rv:expressionState rv:Active ;
      rv:propositionKind rv:ConceptAssertion ;
      rv:assertedConcept ${iri(slot.concept)} .
    ${slot.contextRevision ? `${iri(slot.acceptanceContext)} a rv:ClassificationContext ;
      rv:contextState rv:Active ; rv:head ${iri(slot.contextRevision)} .` :
      `${iri(slot.acceptanceContext)} a rv:ClassificationContext ; rv:contextState rv:Active .`}
  }
  GRAPH ${iri(GRAPHS.revisions)} { ${iri(slot.headDecision)} a rv:ClassificationDecision ;
    rv:component ${iri(input.application)} ; rv:application ${iri(input.application)} ;
    rv:outcome rv:${outcome === 'accepted' ? 'Accepted' : 'Rejected'} ;
    rv:decisionBasis rv:${basis === 'global-curator-review' ? 'GlobalCuratorReview' : 'RealmManagerReview'} ;
    rv:decidedBy ${iri(slot.headDecidedBy)} ;
    rv:decisionPolicy <https://rezics.com/definition/classification-direct-decision-v1>
    ${slot.contextRevision ? `; rv:contextRevision ${iri(slot.contextRevision)}` : ''} .
    ${iri(slot.senseRevision)} a rv:RevisionAnchor ; rv:component ${iri(value('sense')!)} ;
      rv:modelRevision ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} . }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ?cutover a rv:OperationReceipt ;
    rv:commandFamily ${lit(CUTOVER_FAMILY)} ; rv:outcome rv:Succeeded ;
    rv:decisionModel ${term(DECISION_MODEL)} . } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?already rv:migratedFrom ${iri(input.application)} } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(decisionSlot.id)} ?p ?o } }`;
  const committed = await commitCommand(env, admission, { family: MIGRATION_FAMILY,
    digest: request.digest, validations, operation, component: decisionSlot.id,
    revision: decision.id, expectedHead: null,
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(statement.id)} a rdf:Statement ;
        rdf:subject ${iri(statement.subject)} ; rdf:predicate ${term(statement.predicate)} ;
        rdf:object ${objectTerm(statement.value)} ;
        rv:relationDefinition ${term(statement.relationDefinition)} ;
        rv:interpretationDefinition ${iri(slot.senseRevision)} ;
        rv:speaker ${iri(statement.speaker)} ; rv:meaningKey ${iri(statement.meaningKey)} ;
        rv:statementState rv:Active ; rv:head ${iri(statement.head)} ;
        rv:migratedFrom ${iri(input.application)} .
      ${iri(decisionSlot.id)} a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ;
        rv:decisionTarget ${iri(statement.meaningKey)} ;
        rv:acceptanceContext ${iri(slot.acceptanceContext)} ; rv:decisionHead ${iri(decision.id)} . }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(statement.head)} a rv:StatementRevision, rv:RevisionAnchor ;
          rv:component ${iri(statement.id)} ; rv:statementState rv:Active ;
          rv:recordedBy ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
          rv:modelRevision ${iri(STATEMENT_PROFILE)} ; rv:shapeRevision ${iri(STATEMENT_PROFILE)} ;
          rv:manifest ${iri(`urn:rezics:sha256:${statementManifest}`)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
        ${iri(decision.id)} a rv:StatementDecision, rv:RevisionAnchor ;
          rv:component ${iri(decisionSlot.id)} ; rv:outcome rv:${outcome === 'accepted' ? 'Accepted' : 'Rejected'} ;
          rv:decisionBasis rv:${basis === 'global-curator-review' ? 'GlobalCuratorReview' : 'RealmManagerReview'} ;
          rv:decidedBy ${iri(decision.decidedBy)} ;
          rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
          ${decision.contextRevision ? `rv:contextRevision ${iri(decision.contextRevision)} ;` : ''}
          rv:support ${iri(statement.id)} ; rv:convertedFrom ${iri(slot.headDecision)} ;
          rv:operation ${iri(operation)} ; rv:modelRevision ${iri(STATEMENT_DECISION_PROFILE)} ;
          rv:shapeRevision ${iri(STATEMENT_DECISION_PROFILE)} ;
          rv:manifest ${iri(`urn:rezics:sha256:${decisionManifest}`)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: guard });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  const sealed = await sealCommandTerminal(env, admission, MIGRATION_FAMILY, 'stale-head',
    `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
      ${iri(input.application)} rv:decisionHead ${iri(input.expectedDecision)} . } }`);
  if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
  throw new ContextCommandUnavailable('v1 classification changed during migration');
}
