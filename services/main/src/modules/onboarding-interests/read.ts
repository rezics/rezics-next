import { GLOBAL_CLASSIFICATION_CONTEXT } from '../classification/context.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { interestKinds, interestSources, matchingWorkKinds } from '../work/work-kinds.ts';
import { type HomeInterestKind, INTEREST_MATCH_COST } from './contract.ts';

// The feed's legacy `interests` filter (see contract.ts); onboarding reads Concepts instead.
const terms = [...new Set(interestKinds.flatMap(kind => interestSources[kind].classificationTerms))];
const termSet = new Set<string>(terms);
const termValues = terms.map(lit).join(', ');

export async function readWorkKindMatches(session: WorkReadSession, works: readonly string[]) {
  const matches = new Map<string, HomeInterestKind[]>();
  if (!works.length) return matches;
  const workTypes = [...new Set(interestKinds.flatMap(kind => interestSources[kind].workTypes))];
  const workTypeSet = new Set<string>(workTypes);
  const typeValues = workTypes.map(type => `<${type}>`).join(' ');
  const rows = await session.query(`SELECT DISTINCT ?work ?type ?term WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    { GRAPH ${iri(GRAPHS.current)} { ?work a ?type }
      VALUES ?type { ${typeValues} } }
    UNION {
      GRAPH ${iri(GRAPHS.current)} {
        ?work rv:mainVersion ?main .
        ?application a rv:ClassificationApplication ; rv:targetMainVersion ?main ;
          rv:classificationContext ${iri(GLOBAL_CLASSIFICATION_CONTEXT)} ;
          rv:applicationState rv:Active ; rv:sense ?sense ; rv:decisionHead ?decision .
        ?sense a rv:ClassificationSense ; rv:senseState rv:Active ; rv:expression ?expression .
        ?expression rv:assertedConcept ?concept . ?concept skos:prefLabel ?label .
      } GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:outcome rv:Accepted . }
      BIND(LCASE(STR(?label)) AS ?term)
      FILTER(?term IN (${termValues}))
    }
  } LIMIT ${INTEREST_MATCH_COST.interestRows + 1}`, INTEREST_MATCH_COST.interestRows + 1);
  if (rows.length > INTEREST_MATCH_COST.interestRows || rows.some(row => !row.work
    || !works.includes(row.work.value) || row.type && !workTypeSet.has(row.type.value)
    || row.term && !termSet.has(row.term.value))) {
    throw new WorkReadUnavailable('Interest Work relation exceeds its bound');
  }
  for (const work of works) {
    const hits = rows.filter(row => row.work?.value === work);
    matches.set(work, matchingWorkKinds(hits.flatMap(row => row.type ? [row.type.value] : []),
      hits.flatMap(row => row.term ? [row.term.value] : [])));
  }
  return matches;
}
