import { readTranslationLinks, type TranslationLink } from '../work/translation-links.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { recordedLanguageTag } from '../release/languages.ts';

/** Preserve the installed target and authority while exposing its source continuity
 * as the Work. An adapter never guesses identity from a title or language. */
export function translationRealization(link: TranslationLink) {
  return { profile: 'realization-v1' as const, id: link.link, revision: link.targetMainRevision,
    work: link.sourceWork, language: recordedLanguageTag(link.contentLanguage), kind: 'translation' as const,
    translators: [link.translator], publishers: [link.publisher],
    source: link.sourceVersionStatus === 'exact'
      ? { kind: 'main-version' as const, work: link.sourceWork,
        mainVersion: link.sourceMainVersion, revision: link.sourceMainRevision! }
      : { kind: 'unresolved' as const, work: link.sourceWork },
    status: link.status === 'official' ? 'official' as const : 'unofficial' as const,
    verification: link.status === 'official' ? 'verified' as const : 'unverified' as const,
    evidence: link.evidence,
    legacy: { ...link },
  };
}

/** Each page names exact installed target revisions; readTranslationLinks retains
 * all its source/authority checks and is bounded to at most twenty adapter calls. */
export async function readLegacyRealization(session: WorkReadSession, work: string, id: string) {
  const rows = await session.query(`SELECT ?main ?revision WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(id)} a rv:TranslationLink ; rv:sourceWork ${iri(work)} ;
      rv:targetMainVersion ?main ; rv:targetMainRevision ?revision }
  } LIMIT 2`, 2);
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0]?.main || !rows[0].revision) throw new Error('Legacy realization is ambiguous');
  const links = await readTranslationLinks(session.deps.environment, rows[0].main.value, rows[0].revision.value);
  const link = links.find(value => value.link === id);
  if (!link) throw new Error('Legacy realization is incomplete');
  // Source and installed target can have independent disclosure. Neither may leak.
  const summaries = await session.summaries([link.targetWork]);
  if (summaries[0]?.status !== 'available') return null;
  return translationRealization(link);
}
