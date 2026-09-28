import { fusekiReadBudget } from '../../infrastructure/fuseki.ts';
import { GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

export const CONCEPT_SEARCH_COST = { candidates: 512, pageSize: 20, bytes: 262_144,
  calls: 3, deadlineMs: 5_000 } as const;
export class ConceptSearchInvalid extends Error {}
export class ConceptSearchUnavailable extends Error {}
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export function conceptLabel(label: string, language: string) {
  const normalized = label.normalize('NFKC').trim();
  if (!normalized || [...normalized].length > 120 || /[\p{Cc}\p{Cf}]/u.test(normalized)
    || !/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i.test(language)) {
    throw new ConceptSearchInvalid('Invalid concept label or language');
  }
  try {
    return { label: normalized, language: Intl.getCanonicalLocales(language)[0]!.toLowerCase() };
  } catch { throw new ConceptSearchInvalid('Invalid concept language'); }
}

/** Labels describe identity; matching a label does not establish equivalence.
 * SKOS labels are language-specific: https://www.w3.org/TR/skos-reference/#labels
 * (reviewed 2026-09-28). NFKC substring matching handles unspaced CJK and width
 * variants without imposing English token boundaries. */
export function matchesConceptLabel(label: string, query: string): boolean {
  return label.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').trim().toLowerCase());
}

/** Explicit scope, never an all-Realm search. Unscoped legacy SKOS concepts are
 * global; a local concept is visible only through its public, active Realm. */
export function conceptScopePattern(realm?: string, concept = '?concept') {
  if (realm && !native.test(realm)) throw new ConceptSearchInvalid('Invalid Realm');
  return `OPTIONAL { ${concept} rv:conceptRealm ?conceptRealm }
    ${realm ? `FILTER(!BOUND(?conceptRealm) || ?conceptRealm = ${iri(realm)})
      FILTER(!BOUND(?conceptRealm) || EXISTS {
        ?conceptRealm a rv:Realm ; rv:realmState rv:Active ; rv:space ?conceptSpace .
        ?conceptSpace rv:realmCapability ?conceptRealm ; rv:disclosure rv:Public . })`
    : 'FILTER(!BOUND(?conceptRealm))'}
    FILTER NOT EXISTS { ${concept} rv:conceptState rv:Retired }
    FILTER NOT EXISTS { ${concept} rv:protectionHead ?conceptProtection }`;
}

/** One bounded candidate relation and no per-result hydration. The conservative
 * discovery cost is O(C) in the chosen language/scope, not an indexed text claim.
 * Above 512 labels fail explicitly instead of returning a misleading empty or
 * partial match. A future indexed owner can widen this ceiling independently. */
export async function searchConcepts(env: WorkActivationEnvironment,
  input: { q: string; language: string; realm?: string; limit?: number }) {
  const query = conceptLabel(input.q, input.language);
  const limit = input.limit ?? CONCEPT_SEARCH_COST.pageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > CONCEPT_SEARCH_COST.pageSize) {
    throw new ConceptSearchInvalid('Invalid concept search limit');
  }
  return fusekiReadBudget.run({ signal: AbortSignal.timeout(CONCEPT_SEARCH_COST.deadlineMs),
    callsLeft: CONCEPT_SEARCH_COST.calls, bytesLeft: CONCEPT_SEARCH_COST.bytes }, async () => {
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX skos: <${SKOS}>
      SELECT DISTINCT ?concept ?label ?conceptRealm WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?concept a ?conceptType ; skos:prefLabel ?label .
        VALUES ?conceptType { skos:Concept rv:AuthorTagConcept }
        FILTER(LCASE(LANG(?label)) = ${lit(query.language)})
        ${conceptScopePattern(input.realm)}
      } } LIMIT ${CONCEPT_SEARCH_COST.candidates + 1}`, CONCEPT_SEARCH_COST.bytes)).results?.bindings;
    if (!rows || rows.length > CONCEPT_SEARCH_COST.candidates) {
      throw new ConceptSearchUnavailable('Concept search candidate budget exceeded');
    }
    await assertGraphAdmissionOpen(env.fuseki, env.lineage);
    const matches = rows.filter(row => row.concept && row.label
      && matchesConceptLabel(row.label.value, query.label)).map(row => ({
      concept: row.concept!.value, label: row.label!.value, language: query.language,
      realm: row.conceptRealm?.value ?? null,
    })).sort((a, b) => a.label.localeCompare(b.label, query.language) || a.concept.localeCompare(b.concept));
    return { items: matches.slice(0, limit), hasMore: matches.length > limit };
  });
}
