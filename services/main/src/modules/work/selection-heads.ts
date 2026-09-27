import { WorkReadUnavailable } from './read-session.ts';
import { GRAPHS, iri, RV, type WorkActivationEnvironment } from './activate.ts';

/** The current relation is keyed by (Main Version, case-insensitive language).
 * A legacy singleton already has its language on its immutable selection, so
 * migration needs no rewritten history or synthetic selection. The next Main
 * revision materializes the complete map, including that legacy head.
 * Cost: one Main-keyed graph lookup, at most 64 heads, 16 KiB; no Work scan. */
export const MAIN_LANGUAGE_LIMIT = 64;
export interface MainLanguageHead { language: string; selection: string }

export function languagePrior(main: string, decision: string): string {
  return `OPTIONAL { ${iri(main)} rv:selectionHead ?prior .
    GRAPH ${iri(GRAPHS.revisions)} {
      ?prior rv:language ?priorLanguage . ${iri(decision)} rv:language ?candidateLanguage .
      FILTER(LCASE(STR(?priorLanguage)) = LCASE(STR(?candidateLanguage))) } }`;
}

export async function readMainLanguageHeads(env: WorkActivationEnvironment, main: string,
  eligible = false): Promise<MainLanguageHead[]> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?selection ?language WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(main)} rv:selectionHead ?selection }
    GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ;
      rv:mainVersion ${iri(main)} ; rv:language ?language . }
    ${eligible ? `GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:contribution ?contribution ;
      rv:publicationDecision ?decision ; rv:selectedDraft ?draft .
      ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
      GRAPH ${iri(GRAPHS.current)} { ?contribution rv:publicationHead ?decision }` : ''}
  } LIMIT ${MAIN_LANGUAGE_LIMIT + 1}`, 16 * 1024)).results?.bindings;
  if (!rows || rows.length > MAIN_LANGUAGE_LIMIT) throw new WorkReadUnavailable('Main language heads exceed their bound');
  const seen = new Set<string>();
  return rows.map(row => {
    const language = row.language?.value;
    const selection = row.selection?.value;
    if (!language || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)
      || !selection || seen.has(language.toLowerCase())) throw new WorkReadUnavailable('Main language heads are ambiguous');
    seen.add(language.toLowerCase());
    return { language, selection };
  });
}

export function chooseMainLanguage(heads: MainLanguageHead[], requested?: string): MainLanguageHead | null {
  if (requested) return heads.find(head => head.language.toLowerCase() === requested.toLowerCase()) ?? null;
  return heads.find(head => head.language === 'en')
    ?? [...heads].sort((a, b) => a.language.localeCompare(b.language))[0] ?? null;
}

/** Restrict a fallback to the matched text unit's language, avoiding a cross
 * product when a Realm has one local decision and Main has several languages. */
export function fallbackLanguage(head: string, language: string): string {
  return `GRAPH ${iri(GRAPHS.revisions)} { ${head} rv:language ${language} }`;
}


/** Rejection suppresses every language; an adoption overrides its own language. */
export function realmLanguage(head: string, language: string): string {
  return `GRAPH ${iri(GRAPHS.revisions)} {
    { ${head} a rv:RealmPublicationRejection } UNION { ${head} rv:language ${language} } }`;
}
