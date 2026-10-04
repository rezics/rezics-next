import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CLASSIFICATION_PROPOSITION_PROFILE } from './proposition.ts';
import { classificationModelRevisions } from './vocabulary.ts';
import {
  CLASSIFICATION_INHERIT_POLICY,
  CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT,
} from './context.ts';
import {
  CLASSIFICATION_DIRECT_DECISION_PROFILE,
  classificationDecisionSlotIri,
  type ClassificationDecisionContext,
} from './decision.ts';
import {
  CLASSIFIED_AS,
  STATEMENT_DECISION_PROFILE,
  decisionSlotIri,
  statementMeaningKey,
} from '../statement/schema.ts';
import { MAX_SEARCH_RESPONSE_BYTES } from '../work/search-readiness.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export class InvalidClassificationResolution extends Error {}
export class ClassificationResolutionUnavailable extends Error {}
export class ClassificationTargetUnavailable extends Error {}

export interface ClassificationResolutionInput {
  work: string;
  mainVersion: string;
  sense: string;
  context: ClassificationDecisionContext;
}

export const CLASSIFICATION_RESOLUTION_COST = {
  candidates: 512,
  queries: 2,
  admissionQueries: 1,
  responseBytes: MAX_SEARCH_RESPONSE_BYTES,
} as const;

/** Literal-key batches retain the same position across remote operations:
 * https://jena.apache.org/documentation/rdfconnection/#remote-transactions
 * (reviewed 2026-10-04). No catalogue enumeration or per-Sense owner exchange. */
export async function resolveClassifications(
  env: WorkActivationEnvironment,
  inputs: readonly ClassificationResolutionInput[],
  position?: { dataEpoch: string; sequence: string },
) {
  if (inputs.length > CLASSIFICATION_RESOLUTION_COST.candidates) {
    throw new InvalidClassificationResolution('classification batch exceeds its candidate bound');
  }
  if (!inputs.length) return [];
  for (const input of inputs) {
    if (
      !nativeId.test(input.work) ||
      !nativeId.test(input.mainVersion) ||
      !nativeId.test(input.sense) ||
      (input.context.kind !== 'global' &&
        (input.context.kind !== 'realm-classification' || !nativeId.test(input.context.id)))
    ) {
      throw new InvalidClassificationResolution('invalid classification resolution request');
    }
  }
  const input = inputs[0]!;
  if (
    inputs.some((row) => JSON.stringify(row.context) !== JSON.stringify(input.context)) ||
    new Set(inputs.map((row) => `${row.work}\0${row.mainVersion}\0${row.sense}`)).size !==
      inputs.length
  ) {
    throw new InvalidClassificationResolution(
      'classification batch must have distinct targets and one scope',
    );
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const realm = input.context.kind === 'realm-classification' ? input.context.id : undefined;
  // Literal keys must be inside GRAPH joins: an outer VALUES table can
  // otherwise join only after ARQ has enumerated the whole relation.
  const baseTargets = inputs
    .map(
      (row) => `{ BIND(${iri(row.work)} AS ?work)
    BIND(${iri(row.mainVersion)} AS ?main) BIND(${iri(row.sense)} AS ?sense)
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(row.work)} a schema:CreativeWork ; rv:mainVersion ${iri(row.mainVersion)} .
      ${iri(row.mainVersion)} a rv:MainVersion ; rv:work ${iri(row.work)} .
      ${iri(row.sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
        rv:interpretationScope ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
        rv:head ?senseRevision ; rv:expression ?expression .
      ?expression a rv:ClassificationExpression ; rv:expressionState rv:Active ; rv:assertedConcept ?concept .
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?senseRevision a rv:RevisionAnchor ;
      rv:component ${iri(row.sense)} ; rv:modelRevision ?senseModel . ${classificationModelRevisions('?senseModel')} }
  }`,
    )
    .join(' UNION ');
  const base = await env.fuseki.query(
    `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?work ?main ?sense ?epoch ?sequence ?context ?contextRevision ?senseRevision ?concept ?cutover WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      BIND(EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ;
        rv:commandFamily "statement-cutover-v1" ; rv:outcome rv:Succeeded ;
        rv:decisionModel <https://rezics.com/vocab/StatementDecisions> } } AS ?cutover)
      GRAPH ${iri(GRAPHS.current)} {
        ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} a rv:ClassificationContext ;
          rv:contextRole rv:GlobalClassification ; rv:contextState rv:Active ;
          rv:inheritancePolicy ${iri(CLASSIFICATION_ISOLATE_POLICY)} .
        ${
          realm
            ? `?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
          ${iri(realm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active ;
            rv:classificationContext ?context .
          ?context a rv:ClassificationContext ; rv:contextRole rv:RealmClassification ;
            rv:contextState rv:Active ; rv:realm ${iri(realm)} ;
            rv:inheritancePolicy ${iri(CLASSIFICATION_INHERIT_POLICY)} ;
            rv:fallbackContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
            rv:head ?contextRevision .`
            : `BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?context)`
        }
        FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:realm ?globalRealm }
        FILTER NOT EXISTS { ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} rv:fallbackContext ?globalFallback }
      }
      { ${baseTargets} }
    } LIMIT ${inputs.length + 1}`,
    CLASSIFICATION_RESOLUTION_COST.responseBytes,
  );
  const baseRows = base.results?.bindings ?? [];
  if (baseRows.length === 0)
    throw new ClassificationTargetUnavailable('classification target is unavailable');
  const key = (work: string, main: string, sense: string) => `${work}\0${main}\0${sense}`;
  const targets = new Map(
    baseRows.map((row) => [
      key(row.work?.value ?? '', row.main?.value ?? '', row.sense?.value ?? ''),
      row,
    ]),
  );
  if (
    baseRows.length !== inputs.length ||
    targets.size !== inputs.length ||
    inputs.some((row) => !targets.has(key(row.work, row.mainVersion, row.sense))) ||
    baseRows.some(
      (row) =>
        !row.epoch ||
        !row.sequence ||
        !row.context ||
        !row.senseRevision ||
        !row.concept ||
        !row.cutover ||
        (realm && !row.contextRevision),
    ) ||
    ['epoch', 'sequence', 'context', 'contextRevision', 'cutover'].some(
      (name) => new Set(baseRows.map((row) => row[name]?.value)).size !== 1,
    )
  ) {
    throw new ClassificationResolutionUnavailable('classification target is ambiguous');
  }
  const target = baseRows[0]!,
    context = target.context!.value;
  if (
    position &&
    (target.epoch!.value !== position.dataEpoch || target.sequence!.value !== position.sequence)
  ) {
    throw new ClassificationResolutionUnavailable('classification batch position moved');
  }
  const cutover = target.cutover!.value === 'true';
  const values = inputs.map((row, index) => {
    const basis = targets.get(key(row.work, row.mainVersion, row.sense))!;
    const meaning = statementMeaningKey({
      subject: row.mainVersion,
      predicate: CLASSIFIED_AS,
      relationDefinition: CLASSIFICATION_PROPOSITION_PROFILE,
      interpretationDefinitions: [basis.senseRevision!.value],
      value: { kind: 'resource', iri: basis.concept!.value },
      applicability: [],
    });
    const slot = (ctx: string) =>
      cutover
        ? decisionSlotIri({ kind: 'qualified-fact', meaningKey: meaning }, ctx)
        : classificationDecisionSlotIri(row.mainVersion, row.sense, ctx);
    return {
      index,
      main: row.mainVersion,
      sense: row.sense,
      meaning,
      global: slot(GLOBAL_CLASSIFICATION_CONTEXT),
      local: slot(context),
    };
  });
  const readSlot = (
    name: 'global' | 'local',
    ctx: string,
    slot: string,
    main: string,
    sense: string,
    meaning: string,
  ) => `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
    ${
      cutover
        ? `${iri(slot)} a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ;
      rv:decisionTarget ${iri(meaning)} ; rv:acceptanceContext ${iri(ctx)} .
      BIND(${iri(slot)} AS ?${name}Application)`
        : `?${name}Application rv:applicationKey ${iri(slot)} .`
    }
    OPTIONAL { ${
      cutover
        ? `${iri(slot)} rv:decisionHead ?${name}Decision .`
        : `?${name}Application a rv:ClassificationApplication ; rv:targetMainVersion ${iri(main)} ;
      rv:sense ${iri(sense)} ; rv:classificationContext ${iri(ctx)} ; rv:applicationChannel rv:Curated ;
      rv:applicationState rv:Active ; rv:decisionHead ?${name}Decision .`
    }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
        ?${name}Decision a ${cutover ? 'rv:StatementDecision' : 'rv:ClassificationDecision'}, rv:RevisionAnchor ;
          rv:component ${cutover ? iri(slot) : `?${name}Application`} ;
          ${cutover ? '' : `rv:application ?${name}Application ;`}
          rv:outcome ?${name}Outcome ; rv:decisionPolicy ${iri(cutover ? STATEMENT_DECISION_PROFILE : CLASSIFICATION_DIRECT_DECISION_PROFILE)} .
        ${
          cutover
            ? `FILTER(?${name}Outcome = rv:Withdrawn || EXISTS { ?${name}Decision rv:support ?support .
          GRAPH ${iri(GRAPHS.current)} { ?support a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> ;
            rv:statementState rv:Active ; rv:meaningKey ${iri(meaning)} ;
            <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> ${iri(main)} } })`
            : ''
        }
      } }
    }
  } }`;
  const decisionTargets = values
    .map(
      (row) => `{ BIND(${row.index} AS ?index)
    ${realm ? readSlot('local', context, row.local, row.main, row.sense, row.meaning) : ''}
    ${readSlot('global', GLOBAL_CLASSIFICATION_CONTEXT, row.global, row.main, row.sense, row.meaning)}
  }`,
    )
    .join(' UNION ');
  const read = await env.fuseki.query(
    `PREFIX rv: <${RV}>
    SELECT ?index ?epoch ?sequence ?localApplication ?localDecision ?localOutcome
      ?globalApplication ?globalDecision ?globalOutcome WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(target.epoch!.value)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:restoreHold true } }
      FILTER ${cutover ? 'EXISTS' : 'NOT EXISTS'} { GRAPH ${iri(GRAPHS.receipts)} { ?cutover a rv:OperationReceipt ;
        rv:commandFamily "statement-cutover-v1" ; rv:outcome rv:Succeeded ;
        rv:decisionModel <https://rezics.com/vocab/StatementDecisions> . } }
      { ${decisionTargets} }
    } LIMIT ${inputs.length + 1}`,
    CLASSIFICATION_RESOLUTION_COST.responseBytes,
  );
  const rows = read.results?.bindings ?? [];
  if (
    rows.length !== inputs.length ||
    new Set(rows.map((row) => row.index?.value)).size !== inputs.length
  ) {
    throw new ClassificationResolutionUnavailable('classification read is ambiguous');
  }
  const byIndex = new Map(rows.map((row) => [Number(row.index?.value), row]));
  return inputs.map((input, index) => {
    const row = byIndex.get(index);
    if (!row)
      throw new ClassificationResolutionUnavailable('classification batch target is missing');
    const value = (key: string) => row[key]?.value;
    if (
      value('epoch') !== target.epoch!.value ||
      value('sequence') !== target.sequence!.value ||
      (value('globalApplication') && (!value('globalDecision') || !value('globalOutcome'))) ||
      (value('localApplication') && (!value('localDecision') || !value('localOutcome'))) ||
      [value('localOutcome'), value('globalOutcome')].some(
        (outcome) =>
          outcome &&
          ![`${RV}Accepted`, `${RV}Rejected`, ...(cutover ? [`${RV}Withdrawn`] : [])].includes(
            outcome,
          ),
      )
    ) {
      throw new ClassificationResolutionUnavailable('classification resolution is incomplete');
    }
    const local = !!realm && !!value('localDecision') && value('localOutcome') !== `${RV}Withdrawn`;
    const global = !!value('globalDecision') && value('globalOutcome') !== `${RV}Withdrawn`;
    const inherited = !!realm && !local && global;
    const decision = local ? value('localDecision') : global ? value('globalDecision') : undefined;
    const application = local
      ? value('localApplication')
      : global
        ? value('globalApplication')
        : undefined;
    const outcome = local ? value('localOutcome') : global ? value('globalOutcome') : undefined;
    return {
      work: input.work,
      mainVersion: input.mainVersion,
      sense: input.sense,
      requestedContext: input.context,
      classificationContext: context,
      contextRevision: target.contextRevision?.value ?? null,
      state:
        outcome === `${RV}Accepted`
          ? ('accepted' as const)
          : outcome === `${RV}Rejected`
            ? ('rejected' as const)
            : ('absent' as const),
      source: local
        ? ('local' as const)
        : inherited
          ? ('inherited-global' as const)
          : global
            ? ('global' as const)
            : ('none' as const),
      sourceContext: decision ? (local ? context : GLOBAL_CLASSIFICATION_CONTEXT) : null,
      application: cutover ? null : (application ?? null),
      decision: decision ?? null,
      policy: realm ? CLASSIFICATION_INHERIT_POLICY : CLASSIFICATION_ISOLATE_POLICY,
      sourcePosition: {
        datasetId: 'product' as const,
        dataEpoch: target.epoch!.value,
        sequence: target.sequence!.value,
      },
    };
  });
}

export async function resolveClassification(
  env: WorkActivationEnvironment,
  input: ClassificationResolutionInput,
) {
  return (await resolveClassifications(env, [input]))[0]!;
}
