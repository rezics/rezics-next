import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { ContextCommandUnavailable } from '../context/command.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { Acceptance } from './graph.ts';
import { decisionSlotIri, resolveAcceptance, type AcceptanceResolution, type DecisionOutcome,
  type DecisionTarget, type SlotReading, type StatementValue } from './schema.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export class StatementNotFound extends Error {}

/**
 * The meaning basis is readable only when its Context is Public or the caller holds the
 * existing read grant; otherwise it is reported unavailable, never replaced or omitted.
 */
export type MeaningBasis =
  | { state: 'none' }
  | { state: 'readable'; context: string; semanticRevision: string; interpretationDefinitions: string[] }
  | { state: 'unavailable' };

export interface StatementRead {
  profile: 'statement-v1';
  statement: string;
  subject: string;
  predicate: string;
  relationDefinition: string;
  value: StatementValue;
  applicability: string[];
  speaker: string;
  meaningKey: string;
  state: 'active' | 'withdrawn';
  revision: string;
  meaningBasis: MeaningBasis;
  export: Record<string, unknown>;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

function valueOf(binding: { type: string; value: string; datatype?: string; 'xml:lang'?: string }): StatementValue {
  if (binding.type === 'uri' && binding.value === `${RV}SomeValue`) return { kind: 'some-value' };
  if (binding.type === 'uri' && binding.value === `${RV}NoValue`) return { kind: 'no-value' };
  if (binding.type === 'uri') return { kind: 'resource', iri: binding.value };
  return { kind: 'literal', lexical: binding.value, language: binding['xml:lang'] ?? null,
    datatype: binding.datatype ?? (binding['xml:lang'] ? `${RDF}langString` : 'http://www.w3.org/2001/XMLSchema#string') };
}

/** One fenced read of the Statement and its pinned basis; a private basis needs `canReadPrivate`. */
export async function readStatement(env: WorkActivationEnvironment, statement: string,
  canReadPrivate: (context: string) => Promise<boolean>): Promise<StatementRead> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
    SELECT ?epoch ?sequence ?subject ?predicate ?object ?relation ?definition ?applicability ?speaker ?key
      ?state ?head ?pin ?context ?disclosure WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} a rdf:Statement ; rdf:subject ?subject ;
        rdf:predicate ?predicate ; rdf:object ?object ; rv:relationDefinition ?relation ; rv:speaker ?speaker ;
        rv:meaningKey ?key ; rv:statementState ?state ; rv:head ?head .
        OPTIONAL { ${iri(statement)} rv:interpretationDefinition ?definition }
        OPTIONAL { ${iri(statement)} rv:applicability ?applicability }
        OPTIONAL { ${iri(statement)} rv:semanticContextRevision ?pin } }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?pin rv:component ?context }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?context rv:disclosure ?disclosure } } }
    } LIMIT 100`)).results?.bindings ?? [];
  const row = rows[0];
  if (!row?.subject) throw new StatementNotFound('Statement is unavailable');
  const single = (key: string) => new Set(rows.map(item => item[key]?.value)).size === 1;
  if (!['subject', 'predicate', 'object', 'relation', 'speaker', 'key', 'state', 'head', 'pin', 'context',
    'disclosure'].every(single) || rows.length >= 100) {
    throw new ContextCommandUnavailable('Statement read is incomplete');
  }
  const definitions = [...new Set(rows.map(item => item.definition?.value).filter(Boolean) as string[])].sort();
  const applicability = [...new Set(rows.map(item => item.applicability?.value).filter(Boolean) as string[])].sort();
  const value = valueOf(row.object!);
  let meaningBasis: MeaningBasis = { state: 'none' };
  if (row.pin) {
    const context = row.context?.value;
    const readable = context && (row.disclosure?.value === `${RV}Public`
      || (row.disclosure?.value === `${RV}Private` && await canReadPrivate(context)));
    meaningBasis = readable ? { state: 'readable', context, semanticRevision: row.pin.value,
      interpretationDefinitions: definitions } : { state: 'unavailable' };
  }
  const object = value.kind === 'resource' ? { '@id': value.iri }
    : value.kind === 'some-value' ? { '@id': `${RV}SomeValue` } : value.kind === 'no-value' ? { '@id': `${RV}NoValue` }
      : { '@value': value.lexical, ...(value.language ? { '@language': value.language } : { '@type': value.datatype }) };
  // The export describes the claim only; it never emits the unconditional base triple.
  const exported: Record<string, unknown> = { '@id': statement, '@type': [`${RDF}Statement`],
    [`${RDF}subject`]: [{ '@id': row.subject.value }], [`${RDF}predicate`]: [{ '@id': row.predicate!.value }],
    [`${RDF}object`]: [object], [`${RV}relationDefinition`]: [{ '@id': row.relation!.value }],
    [`${RV}speaker`]: [{ '@id': row.speaker!.value }], [`${RV}meaningKey`]: [{ '@id': row.key!.value }],
    ...(meaningBasis.state === 'readable' ? {
      [`${RV}semanticContextRevision`]: [{ '@id': meaningBasis.semanticRevision }],
      [`${RV}interpretationDefinition`]: definitions.map(id => ({ '@id': id })) } : {}),
    ...(applicability.length ? { [`${RV}applicability`]: applicability.map(id => ({ '@id': id })) } : {}) };
  return { profile: 'statement-v1', statement, subject: row.subject.value, predicate: row.predicate!.value,
    relationDefinition: row.relation!.value, value, applicability, speaker: row.speaker!.value,
    meaningKey: row.key!.value, state: row.state!.value === `${RV}Withdrawn` ? 'withdrawn' : 'active',
    revision: row.head!.value, meaningBasis, export: exported,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value } };
}

export interface StatementResolution {
  profile: 'statement-resolution-v1';
  target: DecisionTarget;
  acceptance: Acceptance;
  acceptanceContext: string;
  policy: string;
  result: AcceptanceResolution;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

const OUTCOMES: Record<string, DecisionOutcome> = {
  [`${RV}Accepted`]: 'accepted', [`${RV}Rejected`]: 'rejected', [`${RV}Withdrawn`]: 'withdrawn',
};

/**
 * Resolve acceptance of one exact target in one decision scope with a single fenced read of the
 * local and Global slots. Only the same target is inherited; a slot present without a readable
 * decision is unavailable, never absent.
 */
export async function resolveStatementAcceptance(env: WorkActivationEnvironment, target: DecisionTarget,
  acceptance: Acceptance): Promise<StatementResolution> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const realm = acceptance.kind === 'realm' ? acceptance.realm : null;
  const globalSlot = decisionSlotIri(target, GLOBAL_CLASSIFICATION_CONTEXT);
  const slotRead = (name: string, slot: string) => `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ${slot} a rv:DecisionSlot . BIND(${slot} AS ?${name}Slot)
        OPTIONAL { ${slot} rv:decisionHead ?${name}Decision .
          OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?${name}Decision a rv:StatementDecision ;
            rv:component ${slot} ; rv:outcome ?${name}Outcome . } } } } }`;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?context ?policy
    ?localSlot ?localDecision ?localOutcome ?globalSlot ?globalDecision ?globalOutcome WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ${realm ? `${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext ?context .
          ?context a rv:ClassificationContext ; rv:contextState rv:Active ; rv:realm ${iri(realm)} ;
            rv:inheritancePolicy ?policy .`
      : `BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?context)
          ?context a rv:ClassificationContext ; rv:contextState rv:Active ; rv:inheritancePolicy ?policy .`} }
      ${realm ? '' : slotRead('global', iri(globalSlot))}
    }`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.context || !rows[0].policy) {
    throw new ContextCommandUnavailable('acceptance scope is unavailable');
  }
  const context = rows[0].context.value;
  const policy = rows[0].policy.value;
  let row = rows[0];
  if (realm) {
    const localSlot = decisionSlotIri(target, context);
    const slots = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence ?localSlot ?localDecision
      ?localOutcome ?globalSlot ?globalDecision ?globalOutcome WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)} && ?sequence = ${row.sequence!.value})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      ${slotRead('local', iri(localSlot))}
      ${policy === CLASSIFICATION_INHERIT_POLICY ? slotRead('global', iri(globalSlot)) : ''}
    }`)).results?.bindings ?? [];
    // The second read must observe the same position as the scope read.
    if (slots.length !== 1) throw new ContextCommandUnavailable('acceptance read moved');
    row = { ...row, ...slots[0] };
  }
  const reading = (name: 'local' | 'global'): SlotReading => {
    if (!row[`${name}Slot`]) return { state: 'absent' };
    const outcome = OUTCOMES[row[`${name}Outcome`]?.value ?? ''];
    if (!row[`${name}Decision`] || !outcome) return { state: 'unavailable' };
    return { state: 'decided', slot: row[`${name}Slot`]!.value, decision: row[`${name}Decision`]!.value, outcome };
  };
  if (![CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY].includes(policy)) {
    throw new ContextCommandUnavailable('acceptance policy is unsupported');
  }
  const result = !realm ? resolveAcceptance({ scope: 'global', global: reading('global') })
    : policy === CLASSIFICATION_INHERIT_POLICY
      ? resolveAcceptance({ scope: 'local', policy: CLASSIFICATION_INHERIT_POLICY, local: reading('local'),
        global: reading('global') })
      : resolveAcceptance({ scope: 'local', policy: CLASSIFICATION_ISOLATE_POLICY, local: reading('local') });
  return { profile: 'statement-resolution-v1', target, acceptance, acceptanceContext: context, policy, result,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value } };
}
