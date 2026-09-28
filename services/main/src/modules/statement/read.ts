import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { ContextCommandUnavailable } from '../context/command.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { MAX_SEARCH_RESPONSE_BYTES } from '../work/search-readiness.ts';
import type { Acceptance } from './graph.ts';
import { decisionSlotIri, resolveAcceptance, type AcceptanceResolution, type DecisionOutcome,
  STATEMENT_LIMITS, type DecisionTarget, type SlotReading, type StatementValue } from './schema.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export class StatementNotFound extends Error {}
export class StatementBatchBudgetExceeded extends Error {}
export class StatementBatchUnavailable extends Error {}
export const MAX_PUBLIC_STATEMENT_BATCH = 512;

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
      ?state ?head ?headRevision ?pin ?context ?disclosure WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} a rdf:Statement ; rdf:subject ?subject ;
        rdf:predicate ?predicate ; rdf:object ?object ; rv:relationDefinition ?relation ; rv:speaker ?speaker ;
        rv:meaningKey ?key ; rv:statementState ?state ; rv:head ?head .
        OPTIONAL { ${iri(statement)} rv:interpretationDefinition ?definition }
        OPTIONAL { ${iri(statement)} rv:applicability ?applicability }
      }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementRevision, rv:RevisionAnchor ;
        rv:component ${iri(statement)} . BIND(?head AS ?headRevision) } }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} rv:semanticContextRevision ?pin }
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?pin a rv:ContextSemanticRevision ; rv:component ?context }
          OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?context rv:disclosure ?disclosure } }
        }
      }
    } LIMIT 100`)).results?.bindings ?? [];
  const row = rows[0];
  if (!row?.subject) throw new StatementNotFound('Statement is unavailable');
  const single = (key: string) => new Set(rows.map(item => item[key]?.value)).size === 1;
  if (!['subject', 'predicate', 'object', 'relation', 'speaker', 'key', 'state', 'head', 'headRevision', 'pin', 'context',
    'disclosure'].every(single) || rows.length >= 100) {
    throw new ContextCommandUnavailable('Statement read is incomplete');
  }
  if (!row.headRevision) throw new ContextCommandUnavailable('Statement head revision is unavailable');
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
      [`${RV}semanticContextRevision`]: [{ '@id': meaningBasis.semanticRevision }] } : {}),
    ...(meaningBasis.state !== 'unavailable' && definitions.length ? {
      [`${RV}interpretationDefinition`]: definitions.map(id => ({ '@id': id })) } : {}),
    ...(applicability.length ? { [`${RV}applicability`]: applicability.map(id => ({ '@id': id })) } : {}) };
  return { profile: 'statement-v1', statement, subject: row.subject.value, predicate: row.predicate!.value,
    relationDefinition: row.relation!.value, value, applicability, speaker: row.speaker!.value,
    meaningKey: row.key!.value, state: row.state!.value === `${RV}Withdrawn` ? 'withdrawn' : 'active',
    revision: row.head!.value, meaningBasis, export: exported,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value } };
}

export interface PublicStatementBatchRow {
  statement: string;
  subject: string;
  predicate: string;
  relationDefinition: string;
  value: StatementValue;
  speaker: string;
  meaningKey: string;
  revision: string;
  applicability: string[];
  meaningBasis: Exclude<MeaningBasis, { state: 'unavailable' }>;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/** One bounded graph read hydrates exact active public supports at one position.
 * A missing/private pin or changed position invalidates the whole batch. */
export async function readPublicStatementsAt(env: WorkActivationEnvironment,
  statements: readonly string[], position: { dataEpoch: string; sequence: string }):
  Promise<Map<string, PublicStatementBatchRow>> {
  const unique = [...new Set(statements)];
  if (unique.length > MAX_PUBLIC_STATEMENT_BATCH) {
    throw new StatementBatchBudgetExceeded('public Statement batch exceeds 512 supports');
  }
  if (unique.some(id => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/u.test(id))
    || position.dataEpoch !== env.lineage.dataEpoch
    || !/^(0|[1-9][0-9]*)$/u.test(position.sequence)) {
    throw new StatementBatchUnavailable('public Statement batch input is invalid');
  }
  if (unique.length === 0) return new Map();
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
    SELECT ?epoch ?sequence ?statement ?subject ?predicate ?object ?relation ?speaker ?key ?head
      ?pin ?context ?disclosure
      (GROUP_CONCAT(DISTINCT STR(?definition); separator="|") AS ?definitions)
      (GROUP_CONCAT(DISTINCT STR(?app); separator="|") AS ?applicability) WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      FILTER(?epoch = ${lit(position.dataEpoch)} && ?sequence = ${position.sequence})
      VALUES ?statement { ${unique.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        ?statement a rdf:Statement ; rv:statementState rv:Active ; rdf:subject ?subject ;
          rdf:predicate ?predicate ; rdf:object ?object ; rv:relationDefinition ?relation ;
          rv:speaker ?speaker ; rv:meaningKey ?key ; rv:head ?head .
        OPTIONAL { ?statement rv:interpretationDefinition ?definition }
        OPTIONAL { ?statement rv:applicability ?app }
        OPTIONAL { ?statement rv:semanticContextRevision ?pin }
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementRevision ; rv:component ?statement . }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
        ?pin a rv:ContextSemanticRevision ; rv:component ?context . }
        GRAPH ${iri(GRAPHS.current)} { ?context rv:disclosure ?disclosure . } }
    } GROUP BY ?epoch ?sequence ?statement ?subject ?predicate ?object ?relation ?speaker ?key ?head
      ?pin ?context ?disclosure
    LIMIT ${MAX_PUBLIC_STATEMENT_BATCH + 1}`, MAX_SEARCH_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_PUBLIC_STATEMENT_BATCH) {
    throw new StatementBatchBudgetExceeded('public Statement batch result exceeds 512 supports');
  }
  const parsed = new Map<string, PublicStatementBatchRow>();
  const references = (raw: string | undefined, limit: number) => {
    if (!raw) return [];
    const values = [...new Set(raw.split('|'))].sort();
    if (values.length > limit || values.some(value => !/^https?:\/\/[^\s<>"{}|\\^`]+$/u.test(value))) {
      throw new StatementBatchUnavailable('public Statement qualifier list is incomplete');
    }
    return values;
  };
  for (const row of rows) {
    const id = row.statement?.value;
    if (!id || !unique.includes(id) || parsed.has(id)
      || row.epoch?.value !== position.dataEpoch || row.sequence?.value !== position.sequence
      || !row.subject || !row.predicate || !row.object || !row.relation || !row.speaker
      || !row.key || !row.head) {
      throw new StatementBatchUnavailable('public Statement batch is incomplete or ambiguous');
    }
    let meaningBasis: PublicStatementBatchRow['meaningBasis'] = { state: 'none' };
    if (row.pin) {
      if (!row.context || row.disclosure?.value !== `${RV}Public`) {
        throw new StatementBatchUnavailable('public Statement meaning basis is unavailable');
      }
      meaningBasis = { state: 'readable', context: row.context.value,
        semanticRevision: row.pin.value,
        interpretationDefinitions: references(row.definitions?.value, STATEMENT_LIMITS.interpretationDefinitions) };
    }
    parsed.set(id, { statement: id, subject: row.subject.value,
      predicate: row.predicate.value, relationDefinition: row.relation.value,
      value: valueOf(row.object), speaker: row.speaker.value, meaningKey: row.key.value,
      revision: row.head.value,
      applicability: references(row.applicability?.value, STATEMENT_LIMITS.applicability),
      meaningBasis,
      sourcePosition: { datasetId: 'product', dataEpoch: position.dataEpoch, sequence: position.sequence } });
  }
  if (parsed.size !== unique.length) {
    throw new StatementBatchUnavailable('an active public Statement support is missing');
  }
  return parsed;
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
  const activeSource = (name: string) => target.kind === 'statement'
    ? `GRAPH ${iri(GRAPHS.current)} { ${iri(target.statement)} a rdf:Statement ;
        rv:statementState rv:Active . }`
    : `?${name}Decision rv:support ?support . GRAPH ${iri(GRAPHS.current)} {
        ?support a rdf:Statement ; rv:statementState rv:Active ;
          rv:meaningKey ${iri(target.meaningKey)} . }`;
  const slotRead = (name: string, slot: string) => `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ${slot} a rv:DecisionSlot . BIND(${slot} AS ?${name}Slot)
        OPTIONAL { ${slot} rv:decisionHead ?${name}Decision .
          OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?${name}Decision a rv:StatementDecision ;
            rv:component ${slot} ; rv:outcome ?${name}Outcome .
            FILTER(?${name}Outcome = rv:Withdrawn || EXISTS { ${activeSource(name)} })
          } } } } }`;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
    SELECT ?epoch ?sequence ?context ?policy
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
    const slots = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
      SELECT ?epoch ?sequence ?localSlot ?localDecision
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
