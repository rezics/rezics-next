import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from './activate.ts';
import { MAX_SEARCH_RESPONSE_BYTES, SearchSnapshotMoved } from './search-readiness.ts';
import { PublicQueryBudgetExceeded, PublicQueryUnavailable } from './search-budget.ts';
import { STATEMENT_DECISION_PROFILE, STATEMENT_LIMITS } from '../statement/schema.ts';
import { readPublicStatementsAt, StatementBatchBudgetExceeded }
  from '../statement/read.ts';

export const MAX_SEARCH_SUPPORTS = 512;

export interface SearchDecisionSupport {
  mainVersion: string;
  meaningKey: string;
  decision: string;
  sourceContext: string;
}

/** One graph read resolves exact active supports for the bounded accepted
 * decisions. No support is borrowed from a different decision or population. */
export async function readSearchDecisionSupports(env: WorkActivationEnvironment,
  position: { dataEpoch: string; sequence: string }, candidates: readonly SearchDecisionSupport[]) {
  const distinct = new Map(candidates.map(candidate =>
    [`${candidate.mainVersion}\0${candidate.decision}`, candidate]));
  if (distinct.size > MAX_SEARCH_SUPPORTS) {
    throw new PublicQueryBudgetExceeded('accepted decisions exceed support hydration budget');
  }
  if (distinct.size === 0) return new Map<string, string[]>();
  const values = [...distinct.values()].map(candidate =>
    `(${iri(candidate.mainVersion)} ${iri(candidate.meaningKey)} ${iri(candidate.decision)} ${iri(candidate.sourceContext)})`).join('\n');
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?sequence ?main ?decision ?support ?pin ?pinContext ?pinDisclosure WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      FILTER(?epoch = ${lit(position.dataEpoch)})
      VALUES (?main ?key ?decision ?context) { ${values} }
      GRAPH ${iri(GRAPHS.current)} {
        ?slot a rv:DecisionSlot ; rv:targetKind rv:QualifiedFactTarget ; rv:decisionTarget ?key ;
          rv:acceptanceContext ?context ; rv:decisionHead ?decision .
        ?support a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement> ;
          rv:statementState rv:Active ; rv:meaningKey ?key ;
          <http://www.w3.org/1999/02/22-rdf-syntax-ns#subject> ?main .
        OPTIONAL { ?support rv:semanticContextRevision ?pin }
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?decision a rv:StatementDecision ; rv:decisionPolicy ${iri(STATEMENT_DECISION_PROFILE)} ;
          rv:outcome rv:Accepted ; rv:support ?support . }
      OPTIONAL { FILTER(BOUND(?pin)) GRAPH ${iri(GRAPHS.revisions)} {
        ?pin a rv:ContextSemanticRevision ; rv:component ?pinContext . }
        GRAPH ${iri(GRAPHS.current)} { ?pinContext rv:disclosure ?pinDisclosure . } }
    } LIMIT ${MAX_SEARCH_SUPPORTS + 1}`, MAX_SEARCH_RESPONSE_BYTES);
  const rows = result.results?.bindings ?? [];
  if (rows.length > MAX_SEARCH_SUPPORTS) {
    throw new PublicQueryBudgetExceeded('active supporting Statements exceed hydration budget');
  }
  if (rows.some(row => row.epoch?.value === position.dataEpoch
    && row.sequence?.value !== position.sequence)) {
    throw new SearchSnapshotMoved('support hydration crossed graph positions');
  }
  const supports = new Map<string, Set<string>>();
  const basis = new Map<string, string>();
  for (const row of rows) {
    const main = row.main?.value, decision = row.decision?.value, support = row.support?.value;
    if (!main || !decision || !support || row.epoch?.value !== position.dataEpoch
      || row.sequence?.value !== position.sequence) {
      throw new PublicQueryUnavailable('support hydration is incomplete');
    }
    const pin = row.pin?.value ?? null;
    if (pin && (!row.pinContext || row.pinDisclosure?.value !== `${RV}Public`)) {
      throw new PublicQueryUnavailable('support meaning basis is not publicly readable');
    }
    const signature = JSON.stringify([pin, row.pinContext?.value ?? null,
      row.pinDisclosure?.value ?? null]);
    if (basis.has(support) && basis.get(support) !== signature) {
      throw new PublicQueryUnavailable('support meaning basis is ambiguous');
    }
    basis.set(support, signature);
    const key = `${main}\0${decision}`;
    if (!distinct.has(key)) throw new PublicQueryUnavailable('unrelated Statement support was returned');
    const set = supports.get(key) ?? new Set<string>();
    set.add(support);
    supports.set(key, set);
  }
  if ([...distinct.keys()].some(key => !supports.get(key)?.size)) {
    throw new PublicQueryUnavailable('accepted decision has no active exact support');
  }
  if ([...supports.values()].some(set => set.size > STATEMENT_LIMITS.support)) {
    throw new PublicQueryUnavailable('accepted decision exceeds its Statement support bound');
  }
  const ids = [...new Set([...supports.values()].flatMap(set => [...set]))];
  let hydrated;
  try { hydrated = await readPublicStatementsAt(env, ids, position); }
  catch (error) {
    if (error instanceof StatementBatchBudgetExceeded) {
      throw new PublicQueryBudgetExceeded('Statement support read exceeds its budget', { cause: error });
    }
    throw new PublicQueryUnavailable('Statement support read is unavailable', { cause: error });
  }
  for (const candidate of distinct.values()) {
    const key = `${candidate.mainVersion}\0${candidate.decision}`;
    for (const support of supports.get(key) ?? []) {
      const read = hydrated.get(support);
      if (!read || read.subject !== candidate.mainVersion || read.meaningKey !== candidate.meaningKey) {
        throw new PublicQueryUnavailable('Statement support does not match its accepted fact');
      }
    }
  }
  return new Map([...supports].map(([key, set]) => [key, [...set].sort()]));
}

export function exactDecisionSupports(supports: Map<string, string[]>,
  mainVersion: string, decision: string): string[] {
  const exact = supports.get(`${mainVersion}\0${decision}`);
  if (!exact?.length) throw new PublicQueryUnavailable('accepted decision support is missing');
  return exact;
}
