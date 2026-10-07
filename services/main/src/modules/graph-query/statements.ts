import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment,
} from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { MAX_SEARCH_RESPONSE_BYTES } from '../work/search-limits.ts';
import { GraphQueryContinuationStale, GraphQueryNotFound, GraphQueryUnavailable,
  withGraphReadBudget, type GraphReadAuthority,
} from './query.ts';
import { checkedStatementGraphQuery, GRAPH_QUERY_COST, GRAPH_QUERY_LIMITS,
  type StatementGraphContinuation, type StatementGraphQuery,
} from './schema.ts';
import { ContextCommandUnavailable } from '../context/command.ts';
import { statementQualificationFromBindings } from '../statement/qualification.ts';
import { statementValueFromManifest } from '../statement/read.ts';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const PROBE = GRAPH_QUERY_LIMITS.candidates;
const CONTINUATION_TTL_MS = 5 * 60_000;
const nativeReference =
  /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
type Binding = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
interface StatementBinding extends Record<string, Binding | undefined> {
  epoch?: Binding; sequence?: Binding; statement?: Binding; head?: Binding;
  manifest?: Binding; subject?: Binding;
  predicate?: Binding; object?: Binding; relation?: Binding; speaker?: Binding; key?: Binding;
  pin?: Binding; context?: Binding; disclosure?: Binding; definitions?: Binding; evidences?: Binding;
  applicability?: Binding; decisions?: Binding;
  qualificationDefinition?: Binding;
  qualificationContext?: Binding;
  precision?: Binding;
  valueQualifiers?: Binding;
  validFrom?: Binding;
  validUntil?: Binding;
  edition?: Binding;
}

function queryText(input: StatementGraphQuery, epoch: string): string {
  const predicate = input.predicate ? `FILTER(?predicate = ${iri(input.predicate)})` : '';
  const after = input.continuation?.after;
  const afterFilter = after ? `FILTER(STR(?statement) > ${lit(after)})` : '';
  const endpoint = input.direction === 'outgoing'
    ? `FILTER(?subject = ${iri(input.anchor)})` : `FILTER(?object = ${iri(input.anchor)})`;
  return `PREFIX rv: <${RV}> PREFIX rdf: <${RDF}>
    SELECT ?epoch ?sequence ?statement ?head ?manifest ?subject ?predicate ?object ?relation ?speaker ?key ?pin
      ?context ?disclosure ?decisions ?qualificationDefinition ?qualificationContext ?precision ?validFrom ?validUntil ?edition
      (GROUP_CONCAT(DISTINCT STR(?definition); separator="|") AS ?definitions)
      (GROUP_CONCAT(DISTINCT STR(?qualifier); separator="|") AS ?valueQualifiers)
      (GROUP_CONCAT(DISTINCT STR(?evidence); separator="|") AS ?evidences)
      (GROUP_CONCAT(DISTINCT STR(?app); separator="|") AS ?applicability) WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(epoch)})
      OPTIONAL {
        { SELECT ?statement ?head ?subject ?predicate ?object ?relation ?speaker ?key ?pin WHERE {
          GRAPH ${iri(GRAPHS.current)} {
            ?statement a rdf:Statement ; rdf:subject ?subject ; rdf:predicate ?predicate ; rdf:object ?object ;
              rv:relationDefinition ?relation ; rv:speaker ?speaker ; rv:meaningKey ?key ;
              rv:statementState rv:Active ; rv:head ?head .
            OPTIONAL { ?statement rv:semanticContextRevision ?pin }
          }
          FILTER(isIRI(?object) && ?object != rv:SomeValue && ?object != rv:NoValue)
          FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ?object a ?objectType } }
          ${endpoint} ${predicate} ${afterFilter}
        } ORDER BY STR(?statement) LIMIT ${PROBE} }
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
          ?head a rv:StatementRevision ; rv:component ?statement .
          OPTIONAL { ?head rv:manifest ?manifest }
          OPTIONAL { ?head rv:evidence ?evidence }
        } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:interpretationDefinition ?definition } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:applicability ?app } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:qualificationDefinition ?qualificationDefinition } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:interpretationContext ?qualificationContext } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:valuePrecision ?precision } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:valueQualifier ?qualifier } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:validFrom ?validFrom } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:validUntil ?validUntil } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?statement rv:editionScope ?edition } }
        OPTIONAL {
          GRAPH ${iri(GRAPHS.current)} { ?statement rv:semanticContextRevision ?pin }
          GRAPH ${iri(GRAPHS.revisions)} { ?pin a rv:ContextSemanticRevision ; rv:component ?context . }
          GRAPH ${iri(GRAPHS.current)} { ?context rv:disclosure ?disclosure . }
        }
        OPTIONAL {
          { SELECT ?statement (GROUP_CONCAT(DISTINCT CONCAT(STR(?decisionKind), "^", STR(?decisionScope), "^",
              STR(?decision), "^", STR(?decisionOutcome), "^", STR(?decisionBasis), "^",
              COALESCE(STR(?decisionContextRevision), "")); separator="|") AS ?decisions) WHERE {
            GRAPH ${iri(GRAPHS.current)} {
              ?statement a rdf:Statement ; rv:meaningKey ?key .
              ?slot a rv:DecisionSlot ; rv:targetKind ?decisionKind ; rv:decisionTarget ?decisionTarget ;
                rv:acceptanceContext ?decisionScope ; rv:decisionHead ?decision .
              FILTER((?decisionKind = rv:StatementTarget && ?decisionTarget = ?statement)
                || (?decisionKind = rv:QualifiedFactTarget && ?decisionTarget = ?key))
              FILTER(?decisionScope = ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} || EXISTS {
                GRAPH ${iri(GRAPHS.current)} {
                  ?decisionScope rv:realm ?decisionRealm .
                  ?decisionRealm a rv:Realm ; rv:realmState rv:Active ; rv:space ?decisionSpace .
                  ?decisionSpace rv:disclosure rv:Public .
                }
              })
            }
            GRAPH ${iri(GRAPHS.revisions)} {
              ?decision a rv:StatementDecision ; rv:component ?slot ; rv:outcome ?decisionOutcome ;
                rv:decisionBasis ?decisionBasis .
              OPTIONAL { ?decision rv:contextRevision ?decisionContextRevision }
            }
          } GROUP BY ?statement }
        }
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    }
    GROUP BY ?epoch ?sequence ?statement ?head ?manifest ?subject ?predicate ?object ?relation ?speaker ?key ?pin ?context ?disclosure ?decisions
      ?qualificationDefinition ?qualificationContext ?precision ?validFrom ?validUntil ?edition
    ORDER BY STR(?statement)`;
}

function statementQueryDigest(input: StatementGraphQuery, readingBinding?: readonly unknown[],
): string {
  return hash(JSON.stringify({ profile: input.profile, actingSubject: input.actingSubject,
    anchor: input.anchor, direction: input.direction, predicate: input.predicate ?? null,
    position: input.position ?? 'mine', readingBinding: readingBinding ?? null,
    }),
  );
}

function values(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const result = value.split('|');
  if (result.length > max || result.some((item) => !/^https?:\/\//u.test(item))) {
    throw new GraphQueryUnavailable('statement evidence or meaning basis is incomplete');
  }
  return [...new Set(result)].sort();
}

/** One bounded ARQ join returns a claim with its exact speaker, Context pin and evidence. */
export async function queryStatementGraph(env: WorkActivationEnvironment,
  authority: GraphReadAuthority & { canReadPrivateContext: (context: string) => Promise<boolean>;
    visibleRecords?: (records: readonly string[]) => Promise<ReadonlySet<string>>;
    readingBinding?: readonly unknown[];
  },
  raw: StatementGraphQuery,
) {
  const input = checkedStatementGraphQuery(raw);
  const digest = statementQueryDigest(input, authority.readingBinding);
  if (input.continuation && (input.continuation.expiresAt <= Date.now()
    || input.continuation.queryDigest !== digest
    || input.continuation.sourcePosition.dataEpoch !== env.lineage.dataEpoch)) {
    throw new GraphQueryContinuationStale('graph query changed; restart at the first page');
  }
  return withGraphReadBudget({ calls: GRAPH_QUERY_COST.statementPage.maxFusekiCalls,
    bytes: GRAPH_QUERY_COST.statementPage.maxFusekiBytes,
    requestMs: GRAPH_QUERY_COST.statementPage.maxRequestMs,
    }, async () => {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  if (!(await authority.canReadResource(input.anchor))) throw new GraphQueryNotFound('graph anchor is unavailable');
  const result = await env.fuseki.query(queryText(input, env.lineage.dataEpoch), MAX_SEARCH_RESPONSE_BYTES,
      );
  const bindings = (result.results?.bindings ?? []) as StatementBinding[];
  const first = bindings[0];
  if (!first?.epoch || !first.sequence || first.epoch.value !== env.lineage.dataEpoch
    || !/^(0|[1-9][0-9]*)$/u.test(first.sequence.value)
    || bindings.some(
          (row) => row.epoch?.value !== first.epoch!.value || row.sequence?.value !== first.sequence!.value,
        )) {
    throw new GraphQueryUnavailable('graph query snapshot is unavailable');
  }
  if (input.continuation && input.continuation.sourcePosition.sequence !== first.sequence.value) {
    throw new GraphQueryContinuationStale('graph query source moved; restart at the first page',
        );
  }
  const rawClaims = bindings.filter((row) => row.statement);
  if (rawClaims.length > PROBE) throw new GraphQueryUnavailable('statement query exceeded its result bound');
      if (new Set(rawClaims.map((row) => row.statement!.value)).size !== rawClaims.length) {
        throw new GraphQueryUnavailable('statement query is ambiguous');
      }
      const qualifications = new Map(
        rawClaims.map((row) => {
          try {
            return [row.statement!.value, statementQualificationFromBindings([row])] as const;
          } catch (error) {
            if (error instanceof ContextCommandUnavailable)
              throw new GraphQueryUnavailable('statement qualification is unavailable');
            throw error;
          }
        }),
      );
      const qualificationReferences = (row: StatementBinding) => {
        const qualification = qualifications.get(row.statement!.value);
        return (
          qualification
            ? [
                qualification.interpretationContext,
                ...(qualification.editionScope === null ? [] : [qualification.editionScope]),
              ]
            : []
        ).filter((ref) => nativeReference.test(ref));
      };
  const revealed = authority.visibleRecords ? await authority.visibleRecords([input.anchor, ...rawClaims.flatMap((row) =>
    [...[row.statement?.value, row.subject?.value, row.object?.value].filter((ref): ref is string => ref !== undefined,
              ),
      ...values(row.applicability?.value, 8),
              ...qualificationReferences(row),
            ]),
          ]) : null;
  if (revealed && !revealed.has(input.anchor)) throw new GraphQueryNotFound('graph anchor is unavailable');
  const claims: Array<Record<string, unknown> & { statement: string }> = [];
  const readable = new Map<string, boolean>();
      if (authority.canReadResources) {
        const references = [...new Set(rawClaims.flatMap(qualificationReferences))];
        for (let offset = 0; offset < references.length; offset += PROBE) {
          const batch = references.slice(offset, offset + PROBE);
          const allowed = await authority.canReadResources(batch);
          for (const ref of batch) readable.set(ref, allowed.has(ref));
        }
      }
      for (const row of rawClaims) {
    if (!row.statement || !row.head || !row.subject || !row.predicate || !row.object || !row.relation
      || !row.speaker || !row.key) throw new GraphQueryUnavailable('statement binding is incomplete');
    if (revealed && [row.statement.value, row.subject.value, row.object.value,
      ...values(row.applicability?.value, 8),
            ...qualificationReferences(row),
          ].some((ref) => !revealed.has(ref))) continue;
    const neighbor = input.direction === 'outgoing' ? row.object.value : row.subject.value;
    if (!readable.has(neighbor)) readable.set(neighbor, await authority.canReadResource(neighbor));
    if (!readable.get(neighbor)) continue;
        const references = qualificationReferences(row);
        for (const ref of references) {
          if (!readable.has(ref)) readable.set(ref, await authority.canReadResource(ref));
        }
        if (references.some((ref) => !readable.get(ref))) continue;
        const qualification = qualifications.get(row.statement.value);
        const definitions = values(row.definitions?.value, 8);
        let meaningBasis: Record<string, unknown> = { state: 'none' };
    if (row.pin) {
      if (!row.context || !row.disclosure) throw new GraphQueryUnavailable('statement Context pin is unavailable');
      const canReadContext = row.disclosure.value === `${RV}Public`
        || (row.disclosure.value === `${RV}Private`
          &&
              (await authority.canReadPrivateContext(row.context.value)));
      meaningBasis = canReadContext ? { state: 'readable', context: row.context.value,
        semanticRevision: row.pin.value, interpretationDefinitions: definitions,
              }
        : { state: 'unavailable' };
        } else if (definitions.length) {
          meaningBasis = { state: 'defined', interpretationDefinitions: definitions };
    }
    const decisions = (row.decisions?.value ?? '').split('|').filter(Boolean).map((value) => {
      const [targetKind, acceptanceContext, revision, outcome, basis, contextRevision] = value.split('^');
      if (!targetKind || !acceptanceContext || !revision || !outcome || !basis
        || !/^(https?:\/\/[^\s<>"{}|\\^`]+|urn:rezics:[^\s<>"{}|\\^`]+)$/u.test(acceptanceContext,
              )) {
        throw new GraphQueryUnavailable('statement decision scope is incomplete');
      }
      return { targetKind: targetKind.replace(RV, ''), acceptanceContext, revision,
        outcome: outcome.replace(RV, ''), basis: basis.replace(RV, ''), contextRevision: contextRevision || null,
            };
    });
    claims.push({ statement: row.statement.value, revision: row.head.value, subject: row.subject.value,
      predicate: row.predicate.value, value: await statementValueFromManifest(
            env,
            row.statement.value,
            row.manifest?.value,
            row.key.value,
            { kind: 'resource', iri: row.object.value },
            qualification,
          ),
      relationDefinition: row.relation.value, speaker: row.speaker.value, meaningKey: row.key.value,
      applicability: values(row.applicability?.value, 8), meaningBasis,
          ...(qualification ? { qualification } : {}),
          evidence: values(row.evidences?.value, 32), decisions,
        });
  }
  const candidateBoundReached = rawClaims.length >= PROBE;
  const hasVisibleMore = claims.length > GRAPH_QUERY_LIMITS.edges;
  const frontier = hasVisibleMore ? 'more'
    : candidateBoundReached ? 'bounded' : 'complete';
  const page = claims.slice(0, GRAPH_QUERY_LIMITS.edges);
  const last = page.at(-1);
  const continuation: StatementGraphContinuation | null = hasVisibleMore && last ? {
    queryDigest: digest,
    sourcePosition: { datasetId: 'product', dataEpoch: first.epoch.value, sequence: first.sequence.value,
              },
    after: last.statement,
    expiresAt: input.continuation?.expiresAt ?? Date.now() + CONTINUATION_TTL_MS,
  } : null;
  return { profile: 'statement-graph-v1' as const, complete: frontier === 'complete', frontier,
    total: page.length, claims: page, continuation,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: first.epoch.value, sequence: first.sequence.value,
        },
      };
  },
  );
}

export { queryText as statementGraphQueryText };
