import { profileValidations } from '../../infrastructure/profile.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { ContextCommandUnavailable, InvalidContextCommand, StaleContextCommand, checkedCommandReceipt,
  commitCommand, readCommandReceipt, sealCommandTerminal, term,
  type ContextCommandReceipt } from '../context/command.ts';
import { resolveInterpretation, type Interpretation,
  type InterpretationSpeaker } from '../context/interpretation.ts';
import { GRAPHS, ID, RV, hash, iri, lit, prepareComponent,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { DECISION_OUTCOME_TERMS, STATEMENT_AUTHORITY, STATEMENT_DECISION_PROFILE, STATEMENT_LIMITS,
  STATEMENT_PROFILE, decisionSlotIri, statementMeaningKey, type DecisionOutcome, type DecisionTarget,
  type StatementMeaning, type StatementValue } from './schema.ts';

export const STATEMENT_FAMILIES = { record: 'statement-record-v1', withdraw: 'statement-withdraw-v1',
  decide: 'statement-decision-v1' } as const;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';

export type StatementSpeaker = { kind: 'personal' } | { kind: 'realm'; realm: string };
export type StatementInterpretationRequest =
  | { kind: 'selected' }
  | { kind: 'explicit'; context: string; semanticRevision: string };

export interface RecordStatementInput {
  speaker: StatementSpeaker;
  subject: string;
  predicate: string;
  relationDefinition: string;
  value: StatementValue;
  applicability: string[];
  interpretation: StatementInterpretationRequest;
  /** A preview result binds the write so a changed default cannot retarget it. */
  expectedInterpretation?: { semanticRevision: string | null; definition: string | null };
  evidence: string[];
  actingSubject: string;
}

export class StatementInterpretationUnresolved extends Error {
  constructor(readonly state: 'unresolved' | 'disabled') { super(`interpretation is ${state}`); }
}

export function speakerIri(input: { speaker: StatementSpeaker; actingSubject: string }): string {
  return input.speaker.kind === 'realm' ? input.speaker.realm : input.actingSubject;
}

export function recordStatementRequest(input: RecordStatementInput) {
  if (!nativeId.test(input.actingSubject) || !nativeId.test(input.subject)
    || (input.speaker.kind === 'realm' && !nativeId.test(input.speaker.realm))
    || (input.interpretation.kind === 'explicit' && !nativeId.test(input.interpretation.semanticRevision))
    || input.evidence.length > STATEMENT_LIMITS.evidence || new Set(input.evidence).size !== input.evidence.length) {
    throw new InvalidContextCommand('invalid Statement request');
  }
  for (const value of input.evidence) term(value);
  term(input.predicate);
  statementMeaningKey({ subject: input.subject, predicate: input.predicate,
    relationDefinition: input.relationDefinition, interpretationDefinitions: [], value: input.value,
    applicability: input.applicability });
  return { ...STATEMENT_AUTHORITY.speak(speakerIri(input)), digest: hash(JSON.stringify([
    STATEMENT_FAMILIES.record, input.speaker, input.subject, input.predicate, input.relationDefinition,
    input.value, [...input.applicability].sort(), input.interpretation, input.expectedInterpretation ?? null,
    [...input.evidence].sort(), input.actingSubject])) };
}

export function objectTerm(value: StatementValue): string {
  if (value.kind === 'resource') return term(value.iri);
  if (value.kind === 'some-value') return `<${RV}SomeValue>`;
  if (value.kind === 'no-value') return `<${RV}NoValue>`;
  return value.language ? `${lit(value.lexical)}@${value.language}`
    : `${lit(value.lexical)}^^${term(value.datatype || XSD_STRING)}`;
}

/** Resolve the Statement's interpretation slot; a write never proceeds on an incomplete result. */
export async function statementInterpretation(env: WorkActivationEnvironment, input: RecordStatementInput,
  speaker: InterpretationSpeaker): Promise<Interpretation> {
  if (input.value.kind !== 'resource') {
    if (input.interpretation.kind === 'explicit') throw new InvalidContextCommand('only a resource value is interpreted');
    return { state: 'resolved', basis: 'none', context: null, semanticRevision: null, definition: null,
      entryRevision: null, selectionRevision: null };
  }
  return resolveInterpretation(env, { object: input.value.iri, relation: input.predicate,
    explicit: input.interpretation.kind === 'explicit'
      ? { context: input.interpretation.context, semanticRevision: input.interpretation.semanticRevision } : null,
    speaker });
}

/**
 * Record one identified Statement. It pins the speaker, exact relation and applied
 * interpretation definitions and the semantic Context revision used; it asserts no
 * base triple and no acceptance.
 */
export async function recordStatement(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: RecordStatementInput, speaker: InterpretationSpeaker): Promise<ContextCommandReceipt> {
  const request = recordStatementRequest(input);
  const family = STATEMENT_FAMILIES.record;
  const existing = await readCommandReceipt(env, admission.id, family);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const interpretation = await statementInterpretation(env, input, speaker);
  if (interpretation.state === 'unavailable') throw new ContextCommandUnavailable('interpretation is unavailable');
  // The route previews first; a slot that became unresolved meanwhile seals as unavailable.
  if (interpretation.state !== 'resolved') throw new ContextCommandUnavailable(`interpretation is ${interpretation.state}`);
  if (input.expectedInterpretation && (input.expectedInterpretation.semanticRevision
    !== interpretation.semanticRevision || input.expectedInterpretation.definition !== interpretation.definition)) {
    return checkedCommandReceipt((await sealCommandTerminal(env, admission, family, 'stale-head'))!,
      admission, request.digest);
  }
  const meaning: StatementMeaning = { subject: input.subject, predicate: input.predicate,
    relationDefinition: input.relationDefinition,
    interpretationDefinitions: interpretation.definition ? [interpretation.definition] : [],
    value: input.value, applicability: input.applicability };
  const meaningKey = statementMeaningKey(meaning);
  const statement = ID + Bun.randomUUIDv7();
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const speakerId = speakerIri(input);
  const manifest = prepareComponent(env.objectDirectory, statement, { revision, meaning, meaningKey,
    speaker: speakerId, semanticContextRevision: interpretation.semanticRevision, state: 'active',
    evidence: [...input.evidence].sort(), recordedBy: input.actingSubject }, STATEMENT_PROFILE);
  const validations = await profileValidations(env.fuseki, 'statement-v1', [
    { shape: `${STATEMENT_PROFILE}/statement-shape`, focus: [statement], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${STATEMENT_PROFILE}/revision-shape`, focus: [revision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  // A Realm selection that chose this meaning must still be the head when the Statement commits.
  const selectionGuard = input.speaker.kind === 'realm' && interpretation.selectionRevision
    ? `GRAPH ${iri(GRAPHS.current)} { ?usedSelection rv:consumer ${iri(input.speaker.realm)} ;
        rv:contextSelectionHead ${iri(interpretation.selectionRevision)} . }` : '';
  const pinGuard = interpretation.semanticRevision
    ? `GRAPH ${iri(GRAPHS.revisions)} { ${iri(interpretation.semanticRevision)} a rv:ContextSemanticRevision . }` : '';
  const realmGuard = input.speaker.kind === 'realm'
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.speaker.realm)} a rv:Realm ; rv:realmState rv:Active . }` : '';
  const committed = await commitCommand(env, admission, { family, digest: request.digest, validations, operation,
    component: statement, revision, expectedHead: null,
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} a rdf:Statement ;
        rdf:subject ${iri(input.subject)} ; rdf:predicate ${term(input.predicate)} ;
        rdf:object ${objectTerm(input.value)} ; rv:relationDefinition ${term(input.relationDefinition)} ;
        ${meaning.interpretationDefinitions.map(value => `rv:interpretationDefinition ${term(value)} ;`).join(' ')}
        ${interpretation.semanticRevision ? `rv:semanticContextRevision ${iri(interpretation.semanticRevision)} ;` : ''}
        ${input.applicability.map(value => `rv:applicability ${term(value)} ;`).join(' ')}
        rv:speaker ${iri(speakerId)} ; rv:meaningKey ${iri(meaningKey)} ; rv:statementState rv:Active ;
        rv:head ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StatementRevision, rv:RevisionAnchor ;
        rv:component ${iri(statement)} ; rv:statementState rv:Active ;
        ${input.evidence.map(value => `rv:evidence ${term(value)} ;`).join(' ')}
        rv:recordedBy ${iri(input.actingSubject)} ; rv:operation ${iri(operation)} ;
        rv:modelRevision ${iri(STATEMENT_PROFILE)} ; rv:shapeRevision ${iri(STATEMENT_PROFILE)} ;
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.subject)} a ?subjectType . }
      ${realmGuard} ${pinGuard} ${selectionGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  if (selectionGuard) {
    const sealed = await sealCommandTerminal(env, admission, family, 'stale-head',
      `FILTER NOT EXISTS { ${selectionGuard} }`);
    if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
  }
  throw new ContextCommandUnavailable('Statement subject or interpretation changed');
}

export interface WithdrawStatementInput {
  statement: string;
  speaker: StatementSpeaker;
  expectedHead: string;
  actingSubject: string;
}

export function withdrawStatementRequest(input: WithdrawStatementInput) {
  if (!nativeId.test(input.statement) || !nativeId.test(input.expectedHead)
    || !nativeId.test(input.actingSubject)
    || (input.speaker.kind === 'realm' && !nativeId.test(input.speaker.realm))) {
    throw new InvalidContextCommand('invalid Statement withdrawal');
  }
  return { ...STATEMENT_AUTHORITY.speak(speakerIri(input)), action: 'statement.withdraw',
    digest: hash(JSON.stringify([STATEMENT_FAMILIES.withdraw, input.statement, input.speaker,
      input.expectedHead, input.actingSubject])) };
}

/** Withdraw the source without erasing its meaning or its retained active revision. */
export async function withdrawStatement(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: WithdrawStatementInput): Promise<ContextCommandReceipt> {
  const request = withdrawStatementRequest(input);
  const family = STATEMENT_FAMILIES.withdraw;
  const existing = await readCommandReceipt(env, admission.id, family);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const speaker = speakerIri(input);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?head ?state WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(input.statement)} a rdf:Statement ;
      rv:speaker ${iri(speaker)} ; rv:head ?head ; rv:statementState ?state . }
  }`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.head || !rows[0].state) {
    throw new ContextCommandUnavailable('Statement is unavailable');
  }
  const stale = `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
    ${iri(input.statement)} rv:head ${iri(input.expectedHead)} ; rv:statementState rv:Active . } }`;
  if (rows[0].head.value !== input.expectedHead || rows[0].state.value !== `${RV}Active`) {
    const sealed = await sealCommandTerminal(env, admission, family, 'stale-head', stale);
    if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
    throw new StaleContextCommand('Statement head changed');
  }
  const revision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const manifest = prepareComponent(env.objectDirectory, input.statement, {
    revision, predecessor: input.expectedHead, state: 'withdrawn', evidence: [],
    recordedBy: input.actingSubject }, STATEMENT_PROFILE);
  const validations = await profileValidations(env.fuseki, 'statement-v1', [
    { shape: `${STATEMENT_PROFILE}/statement-shape`, focus: [input.statement],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${STATEMENT_PROFILE}/revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const committed = await commitCommand(env, admission, { family, digest: request.digest, validations,
    operation, component: input.statement, revision, expectedHead: input.expectedHead,
    remove: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.statement)} rv:head ${iri(input.expectedHead)} ;
      rv:statementState rv:Active . }`,
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.statement)} rv:head ${iri(revision)} ;
        rv:statementState rv:Withdrawn . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StatementRevision, rv:RevisionAnchor ;
        rv:component ${iri(input.statement)} ; rv:predecessor ${iri(input.expectedHead)} ;
        rv:statementState rv:Withdrawn ; rv:recordedBy ${iri(input.actingSubject)} ;
        rv:operation ${iri(operation)} ; rv:modelRevision ${iri(STATEMENT_PROFILE)} ;
        rv:shapeRevision ${iri(STATEMENT_PROFILE)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `GRAPH ${iri(GRAPHS.current)} { ${iri(input.statement)} a rdf:Statement ;
        rv:speaker ${iri(speaker)} ; rv:head ${iri(input.expectedHead)} ;
        rv:statementState rv:Active . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  const sealed = await sealCommandTerminal(env, admission, family, 'stale-head', stale);
  if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
  throw new ContextCommandUnavailable('Statement changed during withdrawal');
}

export type Acceptance = { kind: 'global' } | { kind: 'realm'; realm: string };
export type DecisionTargetInput =
  | { kind: 'statement'; statement: string }
  | { kind: 'qualified-fact'; meaningKey: string; support: string[] };

export interface SetStatementDecisionInput {
  target: DecisionTargetInput;
  acceptance: Acceptance;
  expectedDecisionHead: string | null;
  outcome: DecisionOutcome;
  actingSubject: string;
}

export function statementDecisionRequest(input: SetStatementDecisionInput) {
  const support = input.target.kind === 'qualified-fact' ? input.target.support : [];
  if (!nativeId.test(input.actingSubject) || (input.expectedDecisionHead !== null
    && !nativeId.test(input.expectedDecisionHead)) || !['accepted', 'rejected', 'withdrawn'].includes(input.outcome)
    || (input.acceptance.kind === 'realm' && !nativeId.test(input.acceptance.realm))
    || (input.target.kind === 'statement' && !nativeId.test(input.target.statement))
    || (input.target.kind === 'qualified-fact' && (!/^urn:rezics:meaning:[0-9a-f]{64}$/.test(input.target.meaningKey)
      || !support.length || support.length > STATEMENT_LIMITS.support || new Set(support).size !== support.length
      || support.some(value => !nativeId.test(value))))) {
    throw new InvalidContextCommand('invalid Statement decision');
  }
  const target = input.target.kind === 'statement' ? input.target
    : { ...input.target, support: [...support].sort() };
  return { ...STATEMENT_AUTHORITY.decide(input.acceptance), digest: hash(JSON.stringify([
    STATEMENT_FAMILIES.decide, target, input.acceptance, input.expectedDecisionHead, input.outcome,
    input.actingSubject])) };
}

/** The retained ClassificationContext used as acceptance scope, and its pinned revision for a Realm. */
export async function acceptanceScope(env: WorkActivationEnvironment, acceptance: Acceptance): Promise<{
  context: string; revision: string | null; policy: string; guard: string }> {
  const realm = acceptance.kind === 'realm' ? acceptance.realm : null;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?context ?revision ?policy WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${realm ? `${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext ?context .
        ?context a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ; rv:contextState rv:Active ;
          rv:realm ${iri(realm)} ; rv:inheritancePolicy ?policy ; rv:head ?revision .`
      : `BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?context)
        ?context a rv:ClassificationContext ; rv:contextRole rv:GlobalClassification ;
          rv:contextState rv:Active ; rv:inheritancePolicy ?policy .`}
    } }`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.context || !rows[0].policy || (realm && !rows[0].revision)) {
    throw new ContextCommandUnavailable('acceptance scope is unavailable');
  }
  const context = rows[0].context.value;
  const revision = rows[0].revision?.value ?? null;
  return { context, revision, policy: rows[0].policy.value,
    guard: `GRAPH ${iri(GRAPHS.current)} { ${iri(context)} a rv:ClassificationContext ; rv:contextState rv:Active
      ${revision ? `; rv:head ${iri(revision)}` : ''} . }` };
}

/** Create or revise the one decision head of an exact target and acceptance scope. */
export async function setStatementDecision(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: SetStatementDecisionInput): Promise<ContextCommandReceipt> {
  const request = statementDecisionRequest(input);
  const family = STATEMENT_FAMILIES.decide;
  const existing = await readCommandReceipt(env, admission.id, family);
  if (existing) return checkedCommandReceipt(existing, admission, request.digest);
  const scope = await acceptanceScope(env, input.acceptance);
  const target: DecisionTarget = input.target.kind === 'statement'
    ? { kind: 'statement', statement: input.target.statement }
    : { kind: 'qualified-fact', meaningKey: input.target.meaningKey };
  const slot = decisionSlotIri(target, scope.context);
  const support = input.target.kind === 'qualified-fact' ? [...input.target.support].sort() : [];
  const targetRows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?statement ?head ?key ?prior WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        VALUES ?statement { ${(input.target.kind === 'statement' ? [input.target.statement] : support).map(iri).join(' ')} }
        ?statement a rdf:Statement ; rv:statementState rv:Active ; rv:head ?head ; rv:meaningKey ?key .
      }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:decisionHead ?prior } }
    }`)).results?.bindings ?? [];
  const expected = input.target.kind === 'statement' ? 1 : support.length;
  if (targetRows.length !== expected || targetRows.some(row => !row.head || (input.target.kind === 'qualified-fact'
    && row.key?.value !== input.target.meaningKey))) {
    throw new ContextCommandUnavailable('decision target is unavailable');
  }
  const prior = targetRows[0]?.prior?.value ?? null;
  const stale = input.expectedDecisionHead
    ? `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:decisionHead ${iri(input.expectedDecisionHead)} } }`
    : `FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:decisionHead ?any } }`;
  if (prior !== input.expectedDecisionHead) {
    const sealed = await sealCommandTerminal(env, admission, family, 'stale-head', stale);
    if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
    throw new StaleContextCommand('decision head changed');
  }
  const targetRevision = input.target.kind === 'statement' ? targetRows[0]!.head!.value : null;
  const decision = ID + Bun.randomUUIDv7();
  const operation = ID + Bun.randomUUIDv7();
  const basis = input.acceptance.kind === 'global' ? 'GlobalCuratorReview' : 'RealmManagerReview';
  const manifest = prepareComponent(env.objectDirectory, slot, { decision, target, support,
    acceptanceContext: scope.context, contextRevision: scope.revision, predecessor: input.expectedDecisionHead,
    outcome: input.outcome, basis, decidedBy: input.actingSubject, targetRevision }, STATEMENT_DECISION_PROFILE);
  const validations = await profileValidations(env.fuseki, 'statement-decision-v1', [
    { shape: `${STATEMENT_DECISION_PROFILE}/slot-shape`, focus: [slot], graphs: [GRAPHS.current, GRAPHS.revisions] },
    { shape: `${STATEMENT_DECISION_PROFILE}/decision-shape`, focus: [decision], graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]);
  const targetGuard = targetRows.map(row => `${iri(row.statement!.value)} a rdf:Statement ;
      rv:statementState rv:Active ; rv:head ${iri(row.head!.value)} ; rv:meaningKey ${iri(row.key!.value)} .`).join('\n');
  const headGuard = input.expectedDecisionHead
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:decisionHead ${iri(input.expectedDecisionHead)} }`
    : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} ?p ?o } }`;
  const targetTerm = target.kind === 'statement' ? iri(target.statement) : iri(target.meaningKey);
  const committed = await commitCommand(env, admission, { family, digest: request.digest, validations, operation,
    component: slot, revision: decision, expectedHead: input.expectedDecisionHead,
    remove: input.expectedDecisionHead
      ? `GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:decisionHead ${iri(input.expectedDecisionHead)} }` : '',
    insert: `GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} a rv:DecisionSlot ;
        rv:targetKind rv:${target.kind === 'statement' ? 'StatementTarget' : 'QualifiedFactTarget'} ;
        rv:decisionTarget ${targetTerm} ; rv:acceptanceContext ${iri(scope.context)} ;
        rv:decisionHead ${iri(decision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} a rv:StatementDecision, rv:RevisionAnchor ;
        rv:component ${iri(slot)} ; ${input.expectedDecisionHead ? `rv:predecessor ${iri(input.expectedDecisionHead)} ;` : ''}
        rv:outcome ${term(DECISION_OUTCOME_TERMS[input.outcome])} ; rv:decisionBasis rv:${basis} ;
        rv:decidedBy ${iri(input.actingSubject)} ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
        ${scope.revision ? `rv:contextRevision ${iri(scope.revision)} ;` : ''}
        ${targetRevision ? `rv:targetRevision ${iri(targetRevision)} ;` : ''}
        ${support.map(value => `rv:support ${iri(value)} ;`).join(' ')}
        rv:operation ${iri(operation)} ; rv:modelRevision ${iri(STATEMENT_DECISION_PROFILE)} ;
        rv:shapeRevision ${iri(STATEMENT_DECISION_PROFILE)} ; rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }`,
    where: `${scope.guard}
      GRAPH ${iri(GRAPHS.current)} { ${targetGuard} }
      ${headGuard}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(decision)} ?p ?o } }` });
  if (committed) return checkedCommandReceipt(committed, admission, request.digest);
  const sealed = await sealCommandTerminal(env, admission, family, 'stale-head', stale);
  if (sealed) return checkedCommandReceipt(sealed, admission, request.digest);
  throw new ContextCommandUnavailable('decision target changed');
}
