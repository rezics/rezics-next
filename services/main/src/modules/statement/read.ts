import { CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY,
  GLOBAL_CLASSIFICATION_CONTEXT,
} from '../classification/context.ts';
import { ContextCommandUnavailable } from '../context/command.ts';
import { readComponent } from '../semantic/command.ts';
import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { MAX_SEARCH_RESPONSE_BYTES, SearchSnapshotMoved } from '../work/search-readiness.ts';
import type { Acceptance } from './graph.ts';
import { decisionSlotIri, resolveAcceptance, type AcceptanceResolution, type DecisionOutcome,
  STATEMENT_LIMITS,
  STATEMENT_PROFILE,
  statementMeaningKey,
  type DecisionTarget, type SlotReading, type StatementMeaning,
  type StatementValue,
} from './schema.ts';
import {
  statementQualificationFromBindings,
  statementQualificationExport,
  statementQualificationKeyTuple,
  normalizeStatementRetainedClaimProvenance,
  type StatementQualification,
} from './qualification.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const PROV = 'http://www.w3.org/ns/prov#';
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
  | { state: 'defined'; interpretationDefinitions: string[] }
  | {
      state: 'readable'; context: string; semanticRevision: string; interpretationDefinitions: string[];
    }
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
  qualification?: StatementQualification;
  export: Record<string, unknown>;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/** Load only the requested anchor and its sealed bytes; never walk or retarget history. */
export async function readStatementRevisionSnapshot(
  env: WorkActivationEnvironment,
  statement: string,
  revision: string,
) {
  const rows =
    (
      await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?manifest ?state ?operation ?recordedBy ?epoch ?sequence WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:StatementRevision, rv:RevisionAnchor ;
        rv:component ${iri(statement)} ; rv:manifest ?manifest ; rv:statementState ?state ;
        rv:operation ?operation ; rv:recordedBy ?recordedBy ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(revision)} a rv:ErasedRevision } }
    } LIMIT 2`)
    ).results?.bindings ?? [];
  if (!rows.length) throw new StatementNotFound('Statement revision is unavailable');
  if (rows.length !== 1) throw new ContextCommandUnavailable('Statement revision is ambiguous');
  return statementRevisionSnapshot(env, statement, revision, rows[0]!);
}

async function statementRevisionSnapshot(
  env: WorkActivationEnvironment,
  statement: string,
  revision: string,
  row: Record<
    string,
    { type: string; value: string; datatype?: string; 'xml:lang'?: string } | undefined
  >,
) {
  const stored = await readComponent(env, row.manifest!.value, statement, STATEMENT_PROFILE);
  if (
    stored.revision !== revision ||
    !['active', 'withdrawn'].includes(String(stored.state)) ||
    row.state?.value !== `${RV}${stored.state === 'active' ? 'Active' : 'Withdrawn'}` ||
    stored.recordedBy !== row.recordedBy?.value
  ) {
    throw new ContextCommandUnavailable('Statement revision differs from its manifest');
  }
  const meaning = stored.meaning as StatementMeaning | undefined;
  if (meaning !== undefined) assertStoredMeaning(meaning, stored.meaningKey);
  let retainedProvenance;
  if (stored.retainedSourceRevision !== undefined) {
    try {
      retainedProvenance = normalizeStatementRetainedClaimProvenance({
        retainedSourceRevision: stored.retainedSourceRevision,
        retainedSourceReceipt: stored.retainedSourceReceipt,
        recordedAt: stored.recordedAt,
        ...(stored.derivation !== undefined ? { derivation: stored.derivation } : {}),
      });
    } catch { throw new ContextCommandUnavailable('Retained Claim provenance is unavailable'); }
  } else if (meaning?.referenceDomain === 'retained-claim') {
    throw new ContextCommandUnavailable('Retained Claim source revision is unavailable');
  }
  return {
    meaning,
    ...(retainedProvenance ? { retainedProvenance } : {}),
    meaningKey: stored.meaningKey as string | undefined,
    speaker: stored.speaker as string | undefined,
    semanticContextRevision: stored.semanticContextRevision as string | null | undefined,
    state: stored.state as 'active' | 'withdrawn',
    operation: row.operation!.value,
    recordedBy: row.recordedBy!.value,
    sourcePosition: {
      datasetId: 'product' as const,
      dataEpoch: row.epoch!.value,
      sequence: row.sequence!.value,
    },
  };
}

function assertStoredMeaning(meaning: StatementMeaning, expected: unknown) {
  try {
    if (statementMeaningKey(meaning) !== expected) throw new Error('key differs');
  } catch {
    throw new ContextCommandUnavailable('Statement revision meaning differs from its key');
  }
}

function assertStoredValue(stored: StatementValue, graph: StatementValue, retained = false) {
  const reference = (value: StatementValue) =>
    value.kind === 'resource'
      ? value.iri
      : value.kind === 'some-value'
        ? `${RV}SomeValue`
        : value.kind === 'no-value'
          ? `${RV}NoValue`
          : null;
  const incompatible =
    stored.kind === 'literal'
      ? graph.kind !== 'literal' ||
        (stored.language ? `${RDF}langString` : stored.datatype) !== graph.datatype ||
        (stored.language?.toLowerCase() ?? null) !== (graph.language?.toLowerCase() ?? null) ||
        ((retained || !stored.datatype.startsWith('http://www.w3.org/2001/XMLSchema#') ||
          stored.datatype === 'http://www.w3.org/2001/XMLSchema#string') &&
          stored.lexical !== graph.lexical)
      : reference(stored) !== reference(graph);
  if (incompatible)
    throw new ContextCommandUnavailable('Statement RDF term differs from its retained meaning');
}

function assertStoredQualification(
  stored: StatementQualification | undefined,
  graph: StatementQualification | undefined,
  retained = false,
) {
  if (
    JSON.stringify(stored === undefined ? null : statementQualificationKeyTuple(stored)) !==
    JSON.stringify(graph === undefined ? null : statementQualificationKeyTuple(graph))
    || retained && (stored?.validFrom !== graph?.validFrom || stored?.validUntil !== graph?.validUntil)
  ) {
    throw new ContextCommandUnavailable(
      'Statement qualification differs from its retained meaning',
    );
  }
}

function valueOf(binding: { type: string; value: string; datatype?: string; 'xml:lang'?: string;
}): StatementValue {
  if (binding.type === 'uri' && binding.value === `${RV}SomeValue`) return { kind: 'some-value' };
  if (binding.type === 'uri' && binding.value === `${RV}NoValue`) return { kind: 'no-value' };
  if (binding.type === 'uri') return { kind: 'resource', iri: binding.value };
  return { kind: 'literal', lexical: binding.value, language: binding['xml:lang'] ?? null,
    datatype: binding.datatype ?? (binding['xml:lang'] ? `${RDF}langString` : 'http://www.w3.org/2001/XMLSchema#string'),
  };
}

/** TDB may intern numbers by value; the sealed meaning retains their authored RDF lexical. */
export async function statementValueFromManifest(
  env: WorkActivationEnvironment,
  statement: string,
  manifest: string | undefined,
  meaningKey: string,
  fallback: StatementValue,
  qualification?: StatementQualification,
): Promise<StatementValue> {
  if (!manifest) {
    if (qualification)
      throw new ContextCommandUnavailable('Statement qualification manifest is unavailable');
    return fallback;
  }
  const stored = await readComponent(env, manifest, statement, STATEMENT_PROFILE);
  const meaning = stored.meaning as StatementMeaning | undefined;
  // Older lifecycle manifests contain only lifecycle; their exact root remains readable separately.
  if (!meaning) {
    if (qualification)
      throw new ContextCommandUnavailable('Statement qualification manifest is incomplete');
    return fallback;
  }
  assertStoredMeaning(meaning, meaningKey);
  if (stored.meaningKey !== meaningKey)
    throw new ContextCommandUnavailable('Statement meaning differs from its key');
  assertStoredValue(meaning.value, fallback, meaning.referenceDomain === 'retained-claim');
  assertStoredQualification(meaning.qualification, qualification, meaning.referenceDomain === 'retained-claim');
  return meaning.value.kind === 'literal' && meaning.value.language
    ? { ...meaning.value, datatype: `${RDF}langString` }
    : meaning.value;
}

/** One fenced read of the Statement and its pinned basis; a private basis needs `canReadPrivate`. */
export async function readStatement(env: WorkActivationEnvironment, statement: string,
  canReadPrivate: (context: string) => Promise<boolean>,
  revision?: string,
): Promise<StatementRead> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
    SELECT ?epoch ?sequence ?subject ?predicate ?object ?relation ?definition ?applicability ?speaker ?key
      ?state ?head ?headRevision ?operation ?recordedBy ?pin ?context ?disclosure
      ?qualificationDefinition ?qualificationContext ?precision ?qualifier ?validFrom ?validUntil ?edition ?manifest WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} a rdf:Statement ; rdf:subject ?subject ;
        rdf:predicate ?predicate ; rdf:object ?object ; rv:relationDefinition ?relation ; rv:speaker ?speaker ;
        rv:meaningKey ?key ; rv:statementState ?state ; rv:head ?head .
        OPTIONAL { ${iri(statement)} rv:interpretationDefinition ?definition }
        OPTIONAL { ${iri(statement)} rv:applicability ?applicability }
        OPTIONAL { ${iri(statement)} rv:qualificationDefinition ?qualificationDefinition }
        OPTIONAL { ${iri(statement)} rv:interpretationContext ?qualificationContext }
        OPTIONAL { ${iri(statement)} rv:valuePrecision ?precision }
        OPTIONAL { ${iri(statement)} rv:valueQualifier ?qualifier }
        OPTIONAL { ${iri(statement)} rv:validFrom ?validFrom }
        OPTIONAL { ${iri(statement)} rv:validUntil ?validUntil }
        OPTIONAL { ${iri(statement)} rv:editionScope ?edition }
      }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementRevision, rv:RevisionAnchor ;
        rv:component ${iri(statement)} ; rv:operation ?operation ; rv:recordedBy ?recordedBy .
        OPTIONAL { ?head rv:manifest ?manifest }
        BIND(?head AS ?headRevision) } }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(statement)} rv:semanticContextRevision ?pin }
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?pin a rv:ContextSemanticRevision ; rv:component ?context }
          OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?context rv:disclosure ?disclosure } }
        }
      }
    } LIMIT 129`)).results?.bindings ?? [];
  const row = rows[0];
  if (!row?.subject) throw new StatementNotFound('Statement is unavailable');
  if (['predicate', 'object', 'relation', 'speaker', 'key', 'state', 'head', 'headRevision',
    'operation', 'recordedBy'].some(key => !row[key])) {
    throw new ContextCommandUnavailable('Statement read is incomplete');
  }
  const single = (key: string) => new Set(rows.map((item) => {
        const binding = item[key];
        return binding
          ? JSON.stringify([
              binding.type,
              binding.value,
              binding.datatype ?? null,
              binding['xml:lang'] ?? null,
            ])
          : null;
      }),
    ).size === 1;
  if (!['subject', 'predicate', 'object', 'relation', 'speaker', 'key', 'state', 'head', 'headRevision',
    'operation', 'recordedBy', 'pin', 'context',
      'manifest',
      'disclosure',
    ].every(single) || rows.length >= 129
  ) {
    throw new ContextCommandUnavailable('Statement read is incomplete');
  }
  if (!row.headRevision) throw new ContextCommandUnavailable('Statement head revision is unavailable');
  // Public provenance comes from the retained revision, never from Access's
  // private admission principal. Reject malformed provenance rather than export it.
  if (rows.flatMap((item) => [item.speaker, item.head, item.operation, item.recordedBy])
    .some(
        (binding) => binding?.type !== 'uri'
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/u.test(binding.value),
      )) {
    throw new ContextCommandUnavailable('Statement public provenance is unavailable');
  }
  const exact = revision
    ? await readStatementRevisionSnapshot(env, statement, revision)
    : row.manifest
      ? await statementRevisionSnapshot(env, statement, row.head!.value, row)
      : undefined;
  if (
    exact?.meaning &&
    (exact.meaningKey !== row.key?.value ||
      exact.speaker !== row.speaker?.value ||
      exact.meaning.subject !== row.subject?.value ||
      exact.meaning.predicate !== row.predicate?.value ||
      exact.meaning.relationDefinition !== row.relation?.value)
  ) {
    throw new ContextCommandUnavailable('Statement immutable meaning differs from its revision');
  }
  const definitions =
    exact?.meaning?.interpretationDefinitions ??
    [...new Set(rows.map((item) => item.definition?.value).filter(Boolean) as string[])].sort();
  const applicability =
    exact?.meaning?.applicability ??
    [...new Set(rows.map((item) => item.applicability?.value).filter(Boolean) as string[])].sort();
  const authored = exact?.meaning?.value;
  const graphValue = valueOf(row.object!);
  if (authored) assertStoredValue(authored, graphValue, exact?.meaning?.referenceDomain === 'retained-claim');
  const value = authored
    ? authored.kind === 'literal' && authored.language
      ? { ...authored, datatype: `${RDF}langString` }
      : authored
    : graphValue;
  const graphQualification = statementQualificationFromBindings(rows);
  if (graphQualification && !exact?.meaning)
    throw new ContextCommandUnavailable('Statement qualification manifest is unavailable');
  if (exact?.meaning?.referenceDomain === 'retained-claim') {
    assertStoredQualification(exact.meaning.qualification, graphQualification, true);
  }
  if (
    exact?.meaning &&
    JSON.stringify(
      exact.meaning.qualification === undefined
        ? null
        : statementQualificationKeyTuple(exact.meaning.qualification),
    ) !==
      JSON.stringify(
        graphQualification === undefined
          ? null
          : statementQualificationKeyTuple(graphQualification),
      )
  ) {
    throw new ContextCommandUnavailable(
      'Statement qualification differs from its retained meaning',
    );
  }
  const qualification = exact?.meaning?.qualification ?? graphQualification;
  let meaningBasis: MeaningBasis = definitions.length
    ? { state: 'defined', interpretationDefinitions: definitions }
    : { state: 'none' };
  if (row.pin) {
    const context = row.context?.value;
    const readable = context && (row.disclosure?.value === `${RV}Public`
      || (row.disclosure?.value === `${RV}Private` && (await canReadPrivate(context))));
    meaningBasis = readable ? { state: 'readable', context, semanticRevision: row.pin.value,
      interpretationDefinitions: definitions,
        } : { state: 'unavailable' };
  }
  const object = value.kind === 'resource' ? { '@id': value.iri }
    : value.kind === 'some-value' ? { '@id': `${RV}SomeValue` } : value.kind === 'no-value' ? { '@id': `${RV}NoValue` }
      : { '@value': value.lexical, ...(value.language ? { '@language': value.language } : { '@type': value.datatype }),
            };
  // The export describes the claim only; it never emits the unconditional base triple.
  const exported: Record<string, unknown> = { '@id': statement, '@type': [`${RDF}Statement`],
    [`${RDF}subject`]: [{ '@id': row.subject.value }], [`${RDF}predicate`]: [{ '@id': row.predicate!.value }],
    [`${RDF}object`]: [object], [`${RV}relationDefinition`]: [{ '@id': row.relation!.value }],
    [`${RV}speaker`]: [{ '@id': row.speaker!.value }], [`${RV}meaningKey`]: [{ '@id': row.key!.value }],
    // PROV-O (https://www.w3.org/TR/prov-o/): attribution describes the speaker;
    // association describes the public recorder of this exact revision's activity.
    // These facts do not establish delegation between recorder and speaker.
    [`${PROV}wasAttributedTo`]: [{ '@id': row.speaker!.value }],
    [`${RV}head`]: [{ '@id': revision ?? row.head!.value, '@type': [`${RV}StatementRevision`, `${PROV}Entity`],
      [`${PROV}wasGeneratedBy`]: [{ '@id': exact?.operation ?? row.operation!.value, '@type': [`${PROV}Activity`],
        [`${PROV}wasAssociatedWith`]: [{ '@id': exact?.recordedBy ?? row.recordedBy!.value }],
          },
        ],
      },
    ],
    ...(meaningBasis.state === 'readable' ? {
      [`${RV}semanticContextRevision`]: [{ '@id': meaningBasis.semanticRevision }],
        } : {}),
    ...(meaningBasis.state !== 'unavailable' && definitions.length ? {
      [`${RV}interpretationDefinition`]: definitions.map((id) => ({ '@id': id })),
        } : {}),
    ...(applicability.length ? { [`${RV}applicability`]: applicability.map((id) => ({ '@id': id })) } : {}),
    ...(qualification ? statementQualificationExport(qualification) : {}),
  };
  return { profile: 'statement-v1', statement, subject: row.subject.value, predicate: row.predicate!.value,
    relationDefinition: row.relation!.value, value, applicability, speaker: row.speaker!.value,
    meaningKey: row.key!.value, state: exact?.state ?? (row.state!.value === `${RV}Withdrawn` ? 'withdrawn' : 'active'),
    revision: revision ?? row.head!.value, meaningBasis, export: exported,
    ...(qualification ? { qualification } : {}),
    sourcePosition:
      revision && exact
        ? exact.sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value },
  };
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
  qualification?: StatementQualification;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

/** One bounded graph read hydrates exact active public supports at one position.
 * A missing/private pin or changed position invalidates the whole batch. */
export async function readPublicStatementsAt(env: WorkActivationEnvironment,
  statements: readonly string[], position: { dataEpoch: string; sequence: string },
  canReadQualificationReferences?: (references: readonly string[]) => Promise<ReadonlySet<string>>,
):
  Promise<Map<string, PublicStatementBatchRow>> {
  const unique = [...new Set(statements)];
  if (unique.length > MAX_PUBLIC_STATEMENT_BATCH) {
    throw new StatementBatchBudgetExceeded('public Statement batch exceeds 512 supports');
  }
  if (unique.some((id) => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/u.test(id))
    || position.dataEpoch !== env.lineage.dataEpoch
    || !/^(0|[1-9][0-9]*)$/u.test(position.sequence)) {
    throw new StatementBatchUnavailable('public Statement batch input is invalid');
  }
  if (unique.length === 0) return new Map();
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
    SELECT ?epoch ?sequence ?statement ?subject ?predicate ?object ?relation ?speaker ?key ?head
      ?pin ?context ?disclosure ?manifest ?qualificationDefinition ?qualificationContext ?precision ?validFrom ?validUntil ?edition
      (GROUP_CONCAT(DISTINCT STR(?definition); separator="|") AS ?definitions)
      (GROUP_CONCAT(DISTINCT STR(?qualifier); separator="|") AS ?valueQualifiers)
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
        OPTIONAL { ?statement rv:qualificationDefinition ?qualificationDefinition }
        OPTIONAL { ?statement rv:interpretationContext ?qualificationContext }
        OPTIONAL { ?statement rv:valuePrecision ?precision }
        OPTIONAL { ?statement rv:valueQualifier ?qualifier }
        OPTIONAL { ?statement rv:validFrom ?validFrom }
        OPTIONAL { ?statement rv:validUntil ?validUntil }
        OPTIONAL { ?statement rv:editionScope ?edition }
        OPTIONAL { ?statement rv:semanticContextRevision ?pin }
      }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementRevision ; rv:component ?statement .
        OPTIONAL { ?head rv:manifest ?manifest } }
      OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
        ?pin a rv:ContextSemanticRevision ; rv:component ?context . }
        GRAPH ${iri(GRAPHS.current)} { ?context rv:disclosure ?disclosure . } }
    } GROUP BY ?epoch ?sequence ?statement ?subject ?predicate ?object ?relation ?speaker ?key ?head
      ?pin ?context ?disclosure ?manifest ?qualificationDefinition ?qualificationContext ?precision ?validFrom ?validUntil ?edition
    LIMIT ${MAX_PUBLIC_STATEMENT_BATCH + 1}`, MAX_SEARCH_RESPONSE_BYTES,
  );
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_PUBLIC_STATEMENT_BATCH) {
    throw new StatementBatchBudgetExceeded('public Statement batch result exceeds 512 supports');
  }
  const parsed = new Map<string, PublicStatementBatchRow>();
  const scopeReferences = new Set<string>();
  for (const row of rows) {
    const qualification = statementQualificationFromBindings([row]);
    for (const reference of qualification
      ? [
          qualification.interpretationContext,
          ...(qualification.editionScope ? [qualification.editionScope] : []),
        ]
      : []) {
      if (/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/u.test(reference))
        scopeReferences.add(reference);
    }
  }
  const readableScopes = new Set<string>();
  if (scopeReferences.size) {
    if (!canReadQualificationReferences)
      throw new StatementBatchUnavailable('public Statement qualification scope is unavailable');
    const references = [...scopeReferences];
    for (let offset = 0; offset < references.length; offset += 64) {
      const allowed = await canReadQualificationReferences(references.slice(offset, offset + 64));
      for (const reference of allowed) readableScopes.add(reference);
    }
  }
  const references = (raw: string | undefined, limit: number) => {
    if (!raw) return [];
    const values = [...new Set(raw.split('|'))].sort();
    if (values.length > limit || values.some((value) => !/^https?:\/\/[^\s<>"{}|\\^`]+$/u.test(value))) {
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
    const definitions = references(
      row.definitions?.value,
      STATEMENT_LIMITS.interpretationDefinitions,
    );
    let meaningBasis: PublicStatementBatchRow['meaningBasis'] = definitions.length
      ? { state: 'defined', interpretationDefinitions: definitions }
      : { state: 'none' };
    if (row.pin) {
      if (!row.context || row.disclosure?.value !== `${RV}Public`) {
        throw new StatementBatchUnavailable('public Statement meaning basis is unavailable');
      }
      meaningBasis = { state: 'readable', context: row.context.value,
        semanticRevision: row.pin.value,
        interpretationDefinitions: definitions,
      };
    }
    const qualification = statementQualificationFromBindings([row]);
    const scopes = qualification
      ? [
          qualification.interpretationContext,
          ...(qualification.editionScope ? [qualification.editionScope] : []),
        ].filter((reference) => /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/u.test(reference))
      : [];
    if (scopes.some((reference) => !readableScopes.has(reference))) {
      throw new StatementBatchUnavailable('public Statement qualification scope is unavailable');
    }
    parsed.set(id, { statement: id, subject: row.subject.value,
      predicate: row.predicate.value, relationDefinition: row.relation.value,
      value: await statementValueFromManifest(
        env,
        id,
        row.manifest?.value,
        row.key.value,
        valueOf(row.object),
        qualification,
      ), speaker: row.speaker.value, meaningKey: row.key.value,
      revision: row.head.value,
      applicability: references(row.applicability?.value, STATEMENT_LIMITS.applicability),
      meaningBasis,
      ...(qualification ? { qualification } : {}),
      sourcePosition: { datasetId: 'product', dataEpoch: position.dataEpoch, sequence: position.sequence,
      },
    });
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
  acceptance: Acceptance,
): Promise<StatementResolution> {
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
    return { state: 'decided', slot: row[`${name}Slot`]!.value, decision: row[`${name}Decision`]!.value, outcome,
    };
  };
  if (![CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY].includes(policy)) {
    throw new ContextCommandUnavailable('acceptance policy is unsupported');
  }
  const result = !realm ? resolveAcceptance({ scope: 'global', global: reading('global') })
    : policy === CLASSIFICATION_INHERIT_POLICY
      ? resolveAcceptance({ scope: 'local', policy: CLASSIFICATION_INHERIT_POLICY, local: reading('local'),
        global: reading('global'),
        })
      : resolveAcceptance({ scope: 'local', policy: CLASSIFICATION_ISOLATE_POLICY, local: reading('local'),
        });
  return { profile: 'statement-resolution-v1', target, acceptance, acceptanceContext: context, policy, result,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch!.value, sequence: row.sequence!.value,
    },
  };
}

export const MAX_STATEMENT_ACCEPTANCE_BATCH = 20;
export const STATEMENT_ACCEPTANCE_BATCH_COST = {
  statements: MAX_STATEMENT_ACCEPTANCE_BATCH,
  graphReads: 3,
} as const;

/** One admission fence, one shared acceptance-scope proof and one exact slot
 * batch for a page of Statements. Withdrawn decisions need no active support;
 * every other decision retains the scalar reader's active-Statement predicate.
 * Local absence, rejection, withdrawal and unavailable slots stay distinct. */
export async function resolveStatementAcceptancesAt(
  env: WorkActivationEnvironment,
  targets: readonly (string | DecisionTarget)[],
  acceptance: Acceptance,
  position: { dataEpoch: string; sequence: string },
): Promise<Map<string, StatementResolution>> {
  if (targets.length > MAX_STATEMENT_ACCEPTANCE_BATCH) {
    throw new StatementBatchBudgetExceeded('Statement acceptance page exceeds 20 targets');
  }
  const byKey = new Map(targets.map((value) => {
    const target: DecisionTarget = typeof value === 'string' ? { kind: 'statement', statement: value } : value;
    const key = target.kind === 'statement' ? target.statement : target.meaningKey;
    return [key, target] as const;
  }),
  );
  const unique = [...byKey.keys()];
  if (
    unique.some((id) => byKey.get(id)!.kind === 'statement'
      ? !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(id)
      : !/^urn:rezics:meaning:[0-9a-f]{64}$/.test(id),
    ) ||
    position.dataEpoch !== env.lineage.dataEpoch ||
    !/^(0|[1-9][0-9]*)$/.test(position.sequence)
  ) {
    throw new StatementBatchUnavailable('Statement acceptance batch input is invalid');
  }
  if (!unique.length) return new Map();
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const realm = acceptance.kind === 'realm' ? acceptance.realm : null;
  const scopes =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT ?epoch ?sequence ?context ?policy WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} {
        ${
          realm
            ? `${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:classificationContext ?context .
          ?context a rv:ClassificationContext ; rv:contextState rv:Active ; rv:realm ${iri(realm)} ; rv:inheritancePolicy ?policy .`
            : `BIND(${iri(GLOBAL_CLASSIFICATION_CONTEXT)} AS ?context)
          ?context a rv:ClassificationContext ; rv:contextState rv:Active ; rv:inheritancePolicy ?policy .`
        }
      }
    } LIMIT 2`,
        4096,
      )
    ).results?.bindings ?? [];
  const scope = scopes[0];
  if (scopes.length !== 1 || !scope?.context || !scope.policy || !scope.epoch || !scope.sequence) {
    throw new StatementBatchUnavailable('Statement acceptance scope is unavailable');
  }
  if (scope.epoch.value !== position.dataEpoch || scope.sequence.value !== position.sequence) {
    throw new SearchSnapshotMoved('Statement acceptance scope moved');
  }
  const context = scope.context.value,
    policy = scope.policy.value;
  if (![CLASSIFICATION_INHERIT_POLICY, CLASSIFICATION_ISOLATE_POLICY].includes(policy)) {
    throw new StatementBatchUnavailable('Statement acceptance policy is unsupported');
  }
  const targetValues = unique.map(
      (statement) => `(${iri(statement)}
    rv:${byKey.get(statement)!.kind === 'statement' ? 'StatementTarget' : 'QualifiedFactTarget'}
    ${iri(decisionSlotIri(byKey.get(statement)!, GLOBAL_CLASSIFICATION_CONTEXT))}
    ${iri(decisionSlotIri(byKey.get(statement)!, context))})`,
    ).join(' ');
  const slots = (name: 'local' | 'global') => `OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
      VALUES (?statement ?wantedKind ?wantedGlobalSlot ?wantedLocalSlot) { ${targetValues} }
      FILTER EXISTS { ?wanted${name === 'local' ? 'Local' : 'Global'}Slot ?presentProperty ?presentValue }
      BIND(?wanted${name === 'local' ? 'Local' : 'Global'}Slot AS ?${name}Slot)
      OPTIONAL { ?${name}Slot rv:decisionHead ?${name}Decision .
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
          VALUES (?statement ?wantedKind ?${name}Slot) { ${unique.map(
              (statement) => `(${iri(statement)}
            rv:${byKey.get(statement)!.kind === 'statement' ? 'StatementTarget' : 'QualifiedFactTarget'}
            ${iri(decisionSlotIri(byKey.get(statement)!,name === 'local' ? context : GLOBAL_CLASSIFICATION_CONTEXT))})`,
            ).join(' ')} }
          ?${name}Decision a rv:StatementDecision ;
          rv:component ?${name}Slot ; rv:outcome ?${name}Outcome .
          FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ?${name}Slot a rv:DecisionSlot ;
            rv:decisionTarget ?statement ; rv:targetKind ?wantedKind ;
            rv:acceptanceContext ${iri(name === 'local' ? context : GLOBAL_CLASSIFICATION_CONTEXT)} } }
          FILTER(?${name}Outcome = rv:Withdrawn
            || ?wantedKind = rv:StatementTarget && EXISTS { GRAPH ${iri(GRAPHS.current)} {
              ?statement a rdf:Statement ; rv:statementState rv:Active } }
            || ?wantedKind = rv:QualifiedFactTarget && EXISTS {
              GRAPH ${iri(GRAPHS.revisions)} { ?${name}Decision rv:support ?support }
              GRAPH ${iri(GRAPHS.current)} { ?support a rdf:Statement ; rv:statementState rv:Active ; rv:meaningKey ?statement }
            }) } } } } }`;
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
    SELECT ?epoch ?sequence ?statement ?localSlot ?localDecision ?localOutcome
      ?globalSlot ?globalDecision ?globalOutcome WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(position.dataEpoch)} && ?sequence = ${position.sequence})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      VALUES (?statement ?wantedKind ?wantedGlobalSlot ?wantedLocalSlot) {
        ${targetValues}
      }
      ${realm ? slots('local') : ''}
      ${!realm || policy === CLASSIFICATION_INHERIT_POLICY ? slots('global') : ''}
    } LIMIT ${unique.length + 1}`,
        32_768,
      )
    ).results?.bindings ?? [];
  if (
    rows.length !== unique.length ||
    new Set(rows.map((row) => row.statement?.value)).size !== unique.length ||
    rows.some(
      (row) =>
        !unique.includes(row.statement?.value ?? '') ||
        row.epoch?.value !== position.dataEpoch ||
        row.sequence?.value !== position.sequence,
    )
  ) {
    throw new StatementBatchUnavailable('Statement acceptance slots are incomplete or ambiguous');
  }
  return new Map(
    rows.map((row) => {
      const reading = (name: 'local' | 'global'): SlotReading => {
        if (!row[`${name}Slot`]) return { state: 'absent' };
        const outcome = OUTCOMES[row[`${name}Outcome`]?.value ?? ''];
        return !row[`${name}Decision`] || !outcome
          ? { state: 'unavailable' }
          : {
              state: 'decided',
              slot: row[`${name}Slot`]!.value,
              decision: row[`${name}Decision`]!.value,
              outcome,
            };
      };
      const result = !realm
        ? resolveAcceptance({ scope: 'global', global: reading('global') })
        : policy === CLASSIFICATION_INHERIT_POLICY
          ? resolveAcceptance({
              scope: 'local',
              policy: CLASSIFICATION_INHERIT_POLICY,
              local: reading('local'),
              global: reading('global'),
            })
          : resolveAcceptance({
              scope: 'local',
              policy: CLASSIFICATION_ISOLATE_POLICY,
              local: reading('local'),
            });
      const statement = row.statement!.value;
      return [
        statement,
        {
          profile: 'statement-resolution-v1',
          target: byKey.get(statement)!,
          acceptance,
          acceptanceContext: context,
          policy,
          result,
          sourcePosition: { datasetId: 'product', ...position },
        },
      ] as [string, StatementResolution];
    }),
  );
}
