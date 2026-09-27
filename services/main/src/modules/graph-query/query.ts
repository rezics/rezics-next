import { readExactDefinition } from '../relation/change.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { assertPublicTextReady, assertSameTextInstance, MAX_SEARCH_RESPONSE_BYTES,
  PHRASE_HIT_PROBE, SearchIndexBudgetExceeded } from '../work/search-readiness.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { fusekiReadBudget, FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded } from '../../infrastructure/fuseki.ts';
import { InvalidGraphQuery, checkedRelationGraphQuery, GRAPH_QUERY_LIMITS, GRAPH_QUERY_READ_LIMITS,
  type RelationGraphContinuation, type RelationGraphQuery } from './schema.ts';

const PROBE = GRAPH_QUERY_LIMITS.candidates;
const CONTINUATION_TTL_MS = 5 * 60_000;

export class GraphQueryNotFound extends Error {}
export class GraphQueryUnavailable extends Error {}
export class GraphQueryBudgetExceeded extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}
export class GraphQueryContinuationStale extends Error {}

export async function withGraphReadBudget<T>(budget: { calls: number; bytes: number; requestMs: number },
  operation: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GraphQueryBudgetExceeded('graph query exceeded its read deadline'));
    }, budget.requestMs);
  });
  try {
    return await Promise.race([fusekiReadBudget.run({ signal: controller.signal,
      callsLeft: budget.calls, bytesLeft: budget.bytes }, operation), expired]);
  } catch (error) {
    if (error instanceof GraphQueryBudgetExceeded) throw error;
    if (error instanceof FusekiReadBudgetExceeded || error instanceof FusekiQueryResponseTooLarge
      || error instanceof SearchIndexBudgetExceeded
      || error instanceof Error && error.name === 'AbortError') {
      throw new GraphQueryBudgetExceeded('graph query exceeded its Fuseki read budget', { cause: error });
    }
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}

export interface GraphReadAuthority {
  canReadResource: (resource: string) => Promise<boolean>;
}

interface Binding { type: string; value: string; datatype?: string; 'xml:lang'?: string }
interface QueryBinding {
  epoch?: Binding; sequence?: Binding; candidateCount?: Binding; unit?: Binding; score?: Binding;
  occurrence?: Binding; revision?: Binding; from?: Binding; to?: Binding; target?: Binding;
  targetExternal?: Binding; applicability?: Binding;
}

/** Admit one bounded discovered page before deriving a visible count. A full
 * raw page is only a lower bound: denied rows may hide later visible rows. */
export async function admitRelationCandidatePage(authority: GraphReadAuthority,
  rows: readonly QueryBinding[]): Promise<{ admitted: QueryBinding[]; rawBoundReached: boolean }> {
  if (rows.length > PROBE) throw new GraphQueryBudgetExceeded('relation candidate page exceeds its bound');
  const admitted: QueryBinding[] = [];
  const readable = new Map<string, boolean>();
  const seenEdges = new Set<string>();
  for (const row of rows) {
    if (!row.occurrence || !row.revision || !row.from || !row.to || !row.target) {
      throw new GraphQueryUnavailable('relation edge binding is incomplete');
    }
    const occurrence = row.occurrence.value;
    const target = row.target.value;
    if (!readable.has(occurrence)) readable.set(occurrence, await authority.canReadResource(occurrence));
    if (!readable.get(occurrence)) continue;
    if (row.targetExternal?.value !== 'true') {
      if (!readable.has(target)) readable.set(target, await authority.canReadResource(target));
      if (!readable.get(target)) continue;
    }
    const key = JSON.stringify([occurrence, row.revision.value, row.from.value, row.to.value]);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    admitted.push(row);
  }
  return { admitted, rawBoundReached: rows.length >= PROBE };
}

function normalizePhrase(value: string): string {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function queryDigest(input: RelationGraphQuery): string {
  return hash(JSON.stringify({ profile: input.profile, actingSubject: input.actingSubject,
    anchor: input.anchor, definition: input.definition, fromRole: input.fromRole, toRole: input.toRole,
    direction: input.direction, roleBindings: input.roleBindings }));
}

function relationQueryText(input: RelationGraphQuery, definitionRoles: ReadonlyMap<string, string>, epoch: string): string {
  const roleIri = (key: string) => definitionRoles.get(key)!;
  const bindings = input.roleBindings.map((binding, index) => `?revision rv:participation ?constraint${index} .
    ?constraint${index} rv:role ${iri(roleIri(binding.role))} ; rv:participant ${iri(binding.participant)} .`).join('\n');
  const anchor = input.anchor.kind === 'resource' ? `BIND(${iri(input.anchor.id)} AS ?seed)` : '';
  const phrase = input.anchor.kind === 'phrase' ? `PREFIX text: <http://jena.apache.org/text#>` : '';
  const phraseSeed = input.anchor.kind === 'phrase' ? `GRAPH <${PUBLIC_SEARCH_GRAPH}> {
      (?unit ?score) text:query (rv:searchBody ${lit(`"${normalizePhrase(input.anchor.phrase).replace(/[\\"]/gu, '\\$&')}"`)} ${PHRASE_HIT_PROBE}) .
      ?unit a rv:MatchUnit ; rv:disclosure rv:Public ; rv:work ?seed ; rv:mainVersion ?main ; rv:selection ?selection . }
    GRAPH ${iri(GRAPHS.current)} { ?main rv:selectionHead ?selection . }
    ${input.anchor.language ? `GRAPH <${PUBLIC_SEARCH_GRAPH}> { ?unit rv:language ${lit(input.anchor.language)} . }` : ''}` : '';
  const after = input.continuation?.after;
  const afterFilter = after ? `FILTER(STR(?occurrence) > ${lit(after.occurrence)}
      || (STR(?occurrence) = ${lit(after.occurrence)} && STR(?revision) > ${lit(after.revision)})
      || (STR(?occurrence) = ${lit(after.occurrence)} && STR(?revision) = ${lit(after.revision)}
        && STR(?from) > ${lit(after.from)})
      || (STR(?occurrence) = ${lit(after.occurrence)} && STR(?revision) = ${lit(after.revision)}
        && STR(?from) = ${lit(after.from)} && STR(?to) > ${lit(after.to)}))` : '';
  const candidateCount = input.anchor.kind === 'phrase' ? `{ SELECT (COUNT(?rawUnit) AS ?candidateCount) WHERE {
      { SELECT ?rawUnit WHERE { GRAPH <${PUBLIC_SEARCH_GRAPH}> {
        (?rawUnit ?rawScore) text:query (rv:searchBody ${lit(`"${normalizePhrase(input.anchor.phrase).replace(/[\\"]/gu, '\\$&')}"`)} ${PHRASE_HIT_PROBE}) .
      } } LIMIT ${PHRASE_HIT_PROBE} }
    } }` : 'BIND(0 AS ?candidateCount)';
  return `PREFIX rv: <${RV}> ${phrase}
    SELECT ?epoch ?sequence ?candidateCount ?unit ?score ?occurrence ?revision ?from ?to ?target ?targetExternal
      (GROUP_CONCAT(DISTINCT STR(?app); separator="|") AS ?applicability) WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(epoch)})
      ${candidateCount}
      OPTIONAL {
        { SELECT ?unit ?score ?occurrence ?revision ?from ?to ?target ?targetExternal WHERE {
          ${anchor ? anchor : ''}
          ${phraseSeed}
          GRAPH ${iri(GRAPHS.current)} { ?occurrence a rv:RelationOccurrence ;
            rv:occurrenceHead ?revision ; rv:relationDefinition ${iri(input.definition)} . }
          GRAPH ${iri(GRAPHS.revisions)} {
            ?revision a rv:RelationOccurrenceRevision ; rv:component ?occurrence ; rv:lifecycle rv:Active ;
              rv:participation ?fromPart, ?toPart .
            ?fromPart rv:role ${iri(roleIri(input.fromRole))} ; rv:participant ?from .
            ?toPart rv:role ${iri(roleIri(input.toRole))} ; rv:participant ?to .
            ${bindings}
          }
          ${afterFilter}
          FILTER EXISTS { GRAPH ${iri(GRAPHS.current)} { ?seed a ?anchorType } }
          ${input.direction === 'outgoing' ? 'FILTER(?from = ?seed) BIND(?to AS ?target)'
            : 'FILTER(?to = ?seed) BIND(?from AS ?target)'}
          FILTER(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?target a ?targetType } }
            || EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?target a rv:ExternalReference } })
          BIND(EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?target a rv:ExternalReference } } AS ?targetExternal)
          FILTER(?from != ?to)
        } ORDER BY STR(?occurrence) STR(?revision) STR(?from) STR(?to) DESC(?score) STR(?unit)
          LIMIT ${PROBE} }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?occurrence rv:applicability ?app } }
      }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
    }
    GROUP BY ?epoch ?sequence ?candidateCount ?unit ?score ?occurrence ?revision ?from ?to ?target ?targetExternal
    ORDER BY STR(?occurrence) STR(?revision) STR(?from) STR(?to) DESC(?score) STR(?unit)
    `;
}

function parseAggregate(value: string | undefined): string[] {
  if (!value) return [];
  const entries = value.split('|');
  if (entries.length > 8 || entries.some(entry => !/^https:\/\//u.test(entry))) {
    throw new GraphQueryUnavailable('relation applicability is incomplete');
  }
  return [...new Set(entries)].sort();
}

function checkedRows(bindings: QueryBinding[], epoch: string) {
  const first = bindings[0];
  if (!first?.epoch || !first.sequence || first.epoch.value !== epoch
    || !/^(0|[1-9][0-9]*)$/u.test(first.sequence.value)
    || bindings.some(row => row.epoch?.value !== epoch || row.sequence?.value !== first.sequence!.value)) {
    throw new GraphQueryUnavailable('graph query snapshot is unavailable');
  }
  return { sequence: first.sequence.value, rows: bindings.filter(row => row.occurrence) };
}

/**
 * One bounded ARQ join binds the source, target, and every requested role
 * condition through the same current RelationOccurrence revision. It returns
 * direct edges only: no reachability result is labeled as causation.
 */
export async function queryRelationGraph(env: WorkActivationEnvironment, authority: GraphReadAuthority,
  raw: RelationGraphQuery) {
  const input = checkedRelationGraphQuery(raw);
  const digest = queryDigest(input);
  if (input.continuation && (input.continuation.expiresAt <= Date.now()
    || input.continuation.queryDigest !== digest
    || input.continuation.sourcePosition.dataEpoch !== env.lineage.dataEpoch)) {
    throw new GraphQueryContinuationStale('graph query changed; restart at the first page');
  }
  return withGraphReadBudget({ calls: GRAPH_QUERY_READ_LIMITS.fusekiCalls,
    bytes: GRAPH_QUERY_READ_LIMITS.fusekiBytes, requestMs: GRAPH_QUERY_READ_LIMITS.requestMs }, async () => {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  if (input.anchor.kind === 'resource' && !await authority.canReadResource(input.anchor.id)) {
    // Missing and private anchors share the same public outcome.
    throw new GraphQueryNotFound('graph anchor is unavailable');
  }
  // Explicit participant constraints are authority inputs. Check them before
  // the ARQ role/text match so a hidden participant cannot act as a probe.
  for (const participant of new Set(input.roleBindings.map(binding => binding.participant))) {
    if (!await authority.canReadResource(participant)) {
      throw new GraphQueryNotFound('graph participant is unavailable');
    }
  }
  const definition = await readExactDefinition(env, input.definition);
  if (!definition) throw new GraphQueryNotFound('relation definition is unavailable');
  const roles = new Map(definition.roles.map(role => [definition.roleKeys[role.role]!, role.role]));
  if (!roles.has(input.fromRole) || !roles.has(input.toRole)
    || input.roleBindings.some(binding => !roles.has(binding.role))) {
    throw new InvalidGraphQuery('role key is not present in the pinned relation definition');
  }
  const index = input.anchor.kind === 'phrase'
    ? await assertPublicTextReady(env.fuseki, env.lineage) : null;
  const query = relationQueryText(input, roles, env.lineage.dataEpoch);
  let result;
  try { result = await env.fuseki.query(query, MAX_SEARCH_RESPONSE_BYTES); }
  catch (error) {
    if (error instanceof SearchIndexBudgetExceeded) throw new GraphQueryBudgetExceeded('text seed exceeds its budget');
    throw error;
  }
  if (index) await assertSameTextInstance(env.fuseki, index);
  const bindings = (result.results?.bindings ?? []) as QueryBinding[];
  const snapshot = checkedRows(bindings, env.lineage.dataEpoch);
  if (input.continuation && input.continuation.sourcePosition.sequence !== snapshot.sequence) {
    throw new GraphQueryContinuationStale('graph query source moved; restart at the first page');
  }
  if (input.anchor.kind === 'phrase') {
    const countValue = bindings[0]?.candidateCount?.value;
    if (!countValue || !/^(0|[1-9][0-9]*)$/u.test(countValue)) {
      throw new GraphQueryUnavailable('phrase candidate proof is unavailable');
    }
    const count = Number(countValue);
    if (!Number.isSafeInteger(count)) throw new GraphQueryUnavailable('phrase candidate count is invalid');
    if (count >= PHRASE_HIT_PROBE) throw new GraphQueryBudgetExceeded('phrase seed exceeds the admitted candidate bound');
  }
  const admission = await admitRelationCandidatePage(authority, snapshot.rows);
  const page = admission.admitted.slice(0, GRAPH_QUERY_LIMITS.edges);
  const hasVisibleMore = admission.admitted.length > GRAPH_QUERY_LIMITS.edges;
  const frontier = hasVisibleMore ? 'more' : admission.rawBoundReached ? 'bounded' : 'complete';
  const edges = page.map(row => ({ occurrence: row.occurrence!.value, revision: row.revision!.value,
    definition: input.definition, from: row.from!.value, fromRole: input.fromRole,
    to: row.to!.value, toRole: input.toRole, applicability: parseAggregate(row.applicability?.value),
    matchReason: input.anchor.kind === 'phrase'
      ? { kind: 'phrase' as const, phrase: input.anchor.phrase, matchUnit: row.unit?.value ?? null,
        score: row.score ? Number(row.score.value) : null }
      : { kind: 'anchor' as const, participant: input.anchor.id } }));
  const last = edges.at(-1);
  const continuation: RelationGraphContinuation | null = hasVisibleMore && last ? {
    queryDigest: digest,
    sourcePosition: { datasetId: 'product', dataEpoch: env.lineage.dataEpoch, sequence: snapshot.sequence },
    after: { occurrence: last.occurrence, revision: last.revision, from: last.from, to: last.to },
    expiresAt: input.continuation?.expiresAt ?? Date.now() + CONTINUATION_TTL_MS,
  } : null;
  return { profile: 'relation-graph-v1' as const, complete: frontier === 'complete', frontier,
    countPrecision: frontier === 'complete' ? 'exact' as const : 'lower-bound' as const,
    total: edges.length, edges, continuation,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: env.lineage.dataEpoch, sequence: snapshot.sequence } };
  });
}

export { relationQueryText as relationGraphQueryText };
