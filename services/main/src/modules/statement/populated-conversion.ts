import type { Pool } from 'pg';
import { profileValidations } from '../../infrastructure/profile.ts';
import { CLASSIFICATION_DIRECT_DECISION_PROFILE, classificationDecisionSlotIri } from '../classification/decision.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from '../classification/proposition.ts';
import { VOCABULARY_PROFILE } from '../classification/vocabulary.ts';
import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { readWorkComponentState } from '../work/history.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent, type WorkActivationEnvironment } from '../work/activate.ts';
import { CLASSIFIED_AS, STATEMENT_PROFILE, STATEMENT_DECISION_PROFILE, statementMeaningKey, decisionSlotIri } from './schema.ts';
import { StatementSeek } from './seek.ts';

export const STATEMENT_CONVERSION_COST = { applicationsPerBatch: 32,
  responseBytes: 1024*1024, deadlineMs: 30_000 } as const;
const identity = (source: string,role: string) => {
  const value = hash(`${source}\0${role}`).slice(0,32);
  return `${ID}${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
};
export interface RetainedClassification {
  application: string; decision: string; manifest: string; main: string; concept: string;
  context: string; proposer: string; decidedBy: string; outcome: 'accepted'|'rejected';
  contextRevision: string|null; operation: string; dataEpoch: string; sequence: string;
}

export async function retainedClassificationConcept(env: WorkActivationEnvironment,payload: Record<string,unknown>) {
  if (typeof payload.senseRevision !== 'string' || typeof payload.sense !== 'string')
    throw new Error('Exact retained definition reference is unavailable');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest ?profile WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(payload.senseRevision)} a rv:RevisionAnchor ;
      rv:component ${iri(payload.sense)} ; rv:manifest ?manifest ; rv:modelRevision ?profile }
  } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.manifest || ![CLASSIFICATION_PROPOSITION_PROFILE,VOCABULARY_PROFILE].includes(rows[0].profile?.value ?? ''))
    throw new Error('Exact retained Concept definition is unavailable');
  const definition = await readWorkComponentState(env,rows[0].manifest.value,payload.sense,rows[0].profile!.value);
  if (typeof definition.concept !== 'string') throw new Error('Exact retained Concept is unavailable');
  iri(definition.concept);
  return definition.concept;
}

/** The exact retained manifest supplies the DefinitionRef. Current Sense heads
 * cannot reinterpret historical decisions during conversion or recovery. */
export async function prepareRetainedClassification(env: WorkActivationEnvironment,input: RetainedClassification) {
  if ([input.application,input.decision,input.main,input.concept,input.proposer,input.decidedBy,input.operation]
    .some(value => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/u.test(value))
    || !/^[1-9][0-9]*$/u.test(input.sequence)
    || !['accepted','rejected'].includes(input.outcome)) throw new Error('Retained classification provenance is invalid');
  const payload = await readWorkComponentState(env,input.manifest,input.application,CLASSIFICATION_DIRECT_DECISION_PROFILE);
  if (payload.mainVersion !== input.main || payload.application !== input.application
    || payload.decision !== input.decision || payload.context !== input.context
    || payload.proposer !== input.proposer || payload.decider !== input.decidedBy || payload.outcome !== input.outcome
    || (payload.contextRevision ?? null) !== input.contextRevision
    || typeof payload.senseRevision !== 'string' || typeof payload.sense !== 'string'
    || typeof payload.work !== 'string') throw new Error('Retained classification manifest differs');
  const definition = payload.senseRevision;
  iri(definition);
  const meaning = {subject: input.main,predicate: CLASSIFIED_AS,relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
    interpretationDefinitions: [definition],value: {kind: 'resource' as const,iri: input.concept},applicability: []};
  const meaningKey = statementMeaningKey(meaning);
  const statement = identity(input.application,meaningKey);
  const revision = identity(statement,'revision');
  const slot = decisionSlotIri({kind: 'qualified-fact',meaningKey},input.context);
  const decision = identity(input.decision,'statement-decision');
  const priorHeads = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(slot)} rv:decisionHead ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementDecision ; rv:component ${iri(slot)} }
  } LIMIT 2`)).results?.bindings ?? [];
  if (priorHeads.length > 1) throw new Error('Retained acceptance predecessor is ambiguous');
  const nativePredecessor = priorHeads[0]?.head?.value !== decision ? priorHeads[0]?.head?.value ?? null : null;
  const present = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
    ${iri(statement)} rv:meaningKey ${iri(meaningKey)} ; rv:head ${iri(revision)} } }`);
  const historicalApplication = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.application)} a rv:ClassificationApplication } }`);
  const statementManifest = prepareComponent(env.objectDirectory,statement,{revision,meaning,meaningKey,
    speaker: input.proposer,semanticContextRevision: null,state: 'active',evidence: [],recordedBy: input.decidedBy,
    migratedFrom: input.application},STATEMENT_PROFILE);
  const basis = input.context === GLOBAL_CLASSIFICATION_CONTEXT ? 'GlobalCuratorReview' : 'RealmManagerReview';
  const legacySlot = classificationDecisionSlotIri(input.main,payload.sense,input.context);
  const decisionManifest = prepareComponent(env.objectDirectory,slot,{decision,target: {kind: 'qualified-fact',meaningKey},
    support: [statement],acceptanceContext: input.context,contextRevision: input.contextRevision,predecessor: nativePredecessor,
    outcome: input.outcome,basis,decidedBy: input.decidedBy,convertedFrom: input.decision},STATEMENT_DECISION_PROFILE);
  const current = `${present.boolean ? '' : `${iri(statement)} a rdf:Statement ; rdf:subject ${iri(input.main)} ; rdf:predicate <${CLASSIFIED_AS}> ;
    rdf:object ${iri(input.concept)} ; rv:relationDefinition ${iri(CLASSIFICATION_PROPOSITION_PROFILE)} ;
    rv:interpretationDefinition ${iri(definition)} ; rv:speaker ${iri(input.proposer)} ; rv:meaningKey ${iri(meaningKey)} ;
    rv:statementState rv:Active ; rv:head ${iri(revision)} ; rv:migratedFrom ${iri(input.application)} .`}
    ${iri(slot)} a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ; rv:decisionTarget ${iri(meaningKey)} ;
    rv:acceptanceContext ${iri(input.context)} ; rv:decisionHead ${iri(decision)} .`;
  // Recovery retains a complete historical snapshot for canonical validation;
  // it creates no current Application or legacy decision head.
  const revisions = `${historicalApplication.boolean ? `${iri(input.application)} rv:decisionHead ${iri(input.decision)} .` : `${iri(input.application)} a rv:ClassificationApplication ;
    rv:targetMainVersion ${iri(input.main)} ; rv:sense ${iri(payload.sense)} ; rv:applicationKey ${iri(legacySlot)} ;
    rv:classificationContext ${iri(input.context)} ; rv:applicationChannel rv:Curated ;
    rv:applicationState rv:Active ; rv:proposer ${iri(input.proposer)} ; rv:decisionHead ${iri(input.decision)} .`}
    ${present.boolean ? '' : `${iri(revision)} a rv:StatementRevision, rv:RevisionAnchor ; rv:component ${iri(statement)} ;
    rv:statementState rv:Active ; rv:recordedBy ${iri(input.decidedBy)} ; rv:operation ${iri(input.operation)} ;
    rv:modelRevision ${iri(STATEMENT_PROFILE)} ; rv:shapeRevision ${iri(STATEMENT_PROFILE)} ;
    rv:manifest ${iri(`urn:rezics:sha256:${statementManifest}`)} ; rv:dataEpoch ${lit(input.dataEpoch)} ; rv:sequence ${input.sequence} .`}
    ${iri(decision)} a rv:StatementDecision, rv:RevisionAnchor ; rv:component ${iri(slot)} ;
    rv:outcome rv:${input.outcome === 'accepted' ? 'Accepted' : 'Rejected'} ; rv:decisionBasis rv:${basis} ;
    rv:decidedBy ${iri(input.decidedBy)} ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
    ${nativePredecessor ? `rv:predecessor ${iri(nativePredecessor)} ;` : ''}
    ${input.contextRevision ? `rv:contextRevision ${iri(input.contextRevision)} ;` : ''}
    rv:support ${iri(statement)} ; rv:convertedFrom ${iri(input.decision)} ; rv:operation ${iri(input.operation)} ;
    rv:modelRevision ${iri(STATEMENT_DECISION_PROFILE)} ; rv:shapeRevision ${iri(STATEMENT_DECISION_PROFILE)} ;
    rv:manifest ${iri(`urn:rezics:sha256:${decisionManifest}`)} ; rv:dataEpoch ${lit(input.dataEpoch)} ; rv:sequence ${input.sequence} .`;
  const validations = await profileValidations(env.fuseki,'statement-v1',[
    {shape: `${STATEMENT_PROFILE}/statement-shape`,focus: [statement],graphs: [GRAPHS.current,GRAPHS.revisions]},
    {shape: `${STATEMENT_PROFILE}/revision-shape`,focus: [revision],graphs: [GRAPHS.current,GRAPHS.revisions]},
  ]);
  validations.push(...await profileValidations(env.fuseki,'statement-decision-v1',[
    {shape: `${STATEMENT_DECISION_PROFILE}/slot-shape`,focus: [slot],graphs: [GRAPHS.current,GRAPHS.revisions]},
    {shape: `${STATEMENT_DECISION_PROFILE}/decision-shape`,focus: [decision],graphs: [GRAPHS.current,GRAPHS.revisions]},
  ]));
  // Retained raw history keeps its reviewed bindings as well as native shapes.
  // These focuses live in revision history; readers consume the native slots.
  const binding = {work: payload.work,main: input.main,sense: payload.sense,'sense-revision': definition,
    context: input.context,'context-kind': input.context === GLOBAL_CLASSIFICATION_CONTEXT ? 'global' : 'realm',
    application: input.application,decision: input.decision,slot: legacySlot,proposer: input.proposer,
    decider: input.decidedBy,outcome: input.outcome,
    ...(typeof payload.realm === 'string' ? {realm: payload.realm} : {}),
    ...(input.contextRevision ? {'context-revision': input.contextRevision} : {}),
    ...(typeof payload.predecessor === 'string' ? {predecessor: payload.predecessor} : {})};
  validations.push(...await profileValidations(env.fuseki,'classification-direct-decision-v1',
    Object.entries({work: payload.work,main: input.main,sense: payload.sense,context: input.context,
      application: input.application,decision: input.decision}).map(([role,focus]) => ({
      shape: `${CLASSIFICATION_DIRECT_DECISION_PROFILE}/${role}-shape`,focus: [focus],graphs: [GRAPHS.current,GRAPHS.revisions]})),binding));
  return {statement,revision,slot,decision,meaningKey,current,revisions,validations,nativePredecessor};
}

/** Explicit offline step, never an API or startup backfill. Both writer fences
 * must be held and legacy admissions settled. Raw Applications, decision
 * revisions, manifests, operations and receipts remain immutable provenance.
 * Per-head maintenance receipts resume after interruption; seek activation is
 * atomic and happens only after every retained current head has been covered. */
export async function convertPopulatedStatements(env: WorkActivationEnvironment,pool: Pool) {
  const epoch = env.lineage.dataEpoch;
  const held = await pool.query<{open: boolean}>('SELECT open FROM access.recovery_fence WHERE id=true');
  if (held.rows[0]?.open !== false) throw new Error('Access writer fence must be held for Statement conversion');
  const pending = await pool.query(`SELECT 1 FROM access.admission WHERE action IN
    ('classification.decision.set','work.create','statement.migrate','statement.cutover') AND state <> 'sealed' LIMIT 1`);
  if (pending.rowCount) throw new Error('Settle pending catalogue/classification admissions before conversion');
  const graph = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
    ${iri(DATASET)} rv:dataEpoch ${lit(epoch)} ; rv:restoreHold true } }`);
  if (!graph.boolean) throw new Error('Graph writer fence must be held for Statement conversion');
  // Readers immediately refuse an old inventory while conversion is incomplete.
  await pool.query(`INSERT INTO access.statement_seek_coverage VALUES ($1,0,false)
    ON CONFLICT (data_epoch) DO UPDATE SET complete=false`,[epoch]);
  let after = '',converted = 0,replayed = 0;
  for (;;) {
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?application ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?application a rv:ClassificationApplication ; rv:applicationChannel rv:Curated ;
        rv:applicationState rv:Active ; rv:decisionHead ?head . }
      FILTER(STR(?application)>${lit(after)}) } ORDER BY STR(?application) LIMIT ${STATEMENT_CONVERSION_COST.applicationsPerBatch}`,
    STATEMENT_CONVERSION_COST.responseBytes)).results?.bindings ?? [];
    for (const row of rows) {
      const application = row.application!.value,head = row.head!.value;
      const retained = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?main ?sense ?concept ?context ?proposer
        ?manifest ?outcome ?decidedBy ?contextRevision ?operation ?epoch ?sequence WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(application)} rv:targetMainVersion ?main ; rv:sense ?sense ;
          rv:classificationContext ?context ; rv:proposer ?proposer . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} a rv:ClassificationDecision ; rv:component ${iri(application)} ;
          rv:manifest ?manifest ; rv:outcome ?outcome ; rv:decidedBy ?decidedBy ; rv:operation ?operation ;
          rv:dataEpoch ?epoch ; rv:sequence ?sequence . OPTIONAL { ${iri(head)} rv:contextRevision ?contextRevision } }
      } LIMIT 2`,STATEMENT_CONVERSION_COST.responseBytes)).results?.bindings ?? [];
      if (retained.length !== 1) throw new Error('Retained classification head is ambiguous');
      const value = retained[0]!;
      const payload = await readWorkComponentState(env,value.manifest!.value,application,CLASSIFICATION_DIRECT_DECISION_PROFILE);
      const concept = await retainedClassificationConcept(env,payload);
      const outcome = value.outcome?.value === `${RV}Accepted` ? 'accepted' : value.outcome?.value === `${RV}Rejected` ? 'rejected' : null;
      if (!outcome) throw new Error('Retained classification outcome is unsupported');
      const prepared = await prepareRetainedClassification(env,{application,decision: head,manifest: value.manifest!.value,
        main: value.main!.value,concept,context: value.context!.value,proposer: value.proposer!.value,
        decidedBy: value.decidedBy!.value,outcome,contextRevision: value.contextRevision?.value ?? null,
        operation: value.operation!.value,dataEpoch: value.epoch!.value,sequence: value.sequence!.value});
      const digest = hash(JSON.stringify(['populated-statement-conversion-v1',epoch,application,head]));
      const receipt = `urn:rezics:maintenance:statement-conversion:${digest}`;
      const existing = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded } }`);
      const covered = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?statement ?revision ?decision WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?statement rv:migratedFrom ${iri(application)} ;
          rv:meaningKey ${iri(prepared.meaningKey)} ; rv:speaker ${iri(value.proposer!.value)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:StatementRevision ; rv:component ?statement .
          FILTER NOT EXISTS { ?revision rv:predecessor ?previousRevision }
          ?decision a rv:StatementDecision ; rv:component ${iri(prepared.slot)} ; rv:convertedFrom ${iri(head)} ; rv:support ?statement }
      } LIMIT 2`)).results?.bindings ?? [];
      if (covered.length > 1) throw new Error('Retained conversion identity is ambiguous');
      const proof = covered[0] ? {statement: covered[0].statement!.value,revision: covered[0].revision!.value,
        decision: covered[0].decision!.value} : prepared;
      // Maintenance preserves the dataset position. The normal command service
      // requires a new outbox position (or a retained recovery cursor), neither
      // of which describes this offline representation conversion.
      if (!existing.boolean) await env.fuseki.update(`PREFIX rv: <${RV}>
        PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
        INSERT { ${covered.length ? '' : `GRAPH ${iri(GRAPHS.current)} { ${prepared.current} }
          GRAPH ${iri(GRAPHS.revisions)} { ${prepared.revisions} }`}
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
            rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(epoch)} ; rv:sequence ?sequence ;
            rv:convertedApplication ${iri(application)} ; rv:convertedDecision ${iri(head)} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(epoch)} ; rv:restoreHold true ; rv:sequence ?sequence }
          GRAPH ${iri(GRAPHS.current)} { ${iri(application)} rv:decisionHead ${iri(head)} }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          ${covered.length ? '' : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(prepared.slot)} ?p ?o } }`} }`);
      const committed = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:requestDigest ${lit(digest)} ; rv:outcome rv:Succeeded }
        GRAPH ${iri(GRAPHS.current)} { ${iri(proof.statement)} rv:meaningKey ${iri(prepared.meaningKey)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(proof.revision)} a rv:StatementRevision ; rv:component ${iri(proof.statement)} .
          ${iri(proof.decision)} a rv:StatementDecision ; rv:convertedFrom ${iri(head)} }
      }`);
      if (!committed.boolean) throw new Error('Statement conversion receipt or current head is unavailable');
      if (existing.boolean) replayed++; else converted++;
    }
    if (rows.length < STATEMENT_CONVERSION_COST.applicationsPerBatch) break;
    after = rows.at(-1)!.application!.value;
  }
  await new StatementSeek(pool,env).rebuild();
  return {converted,replayed};
}
