import { primaryDiscoveryCredits, namedDiscoveryCredits } from '../discovery/credits.ts';
import type { DiscoveryCredit, ProjectedCredit } from '../discovery/contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { readMetadataHeader, selectedMetadata } from '../work/metadata-read.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { PUBLIC_SEARCH_GRAPH } from '../work/select-main.ts';
import { FEED_COST } from './contract.ts';

export interface FeedWorkPresentation { authors: DiscoveryCredit[]; excerpt: string | null; language: string | null }

/** At most eight Works: one head batch, eight exact metadata reads, eight
 * bounded credit reads, one name batch and eight current-public text reads. */
export async function feedWorkPresentations(session: WorkReadSession, works: readonly string[]) {
  const ids = [...new Set(works)];
  if (ids.length > FEED_COST.candidates) throw new WorkReadUnavailable('Feed Work presentation budget exceeded');
  const result = new Map<string, FeedWorkPresentation>();
  if (!ids.length) return result;
  const heads = await session.query(`SELECT ?work ?head WHERE {
    VALUES ?work { ${ids.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork . OPTIONAL { ?work rv:descriptiveMetadataHead ?head } }
  } LIMIT ${ids.length + 1}`, ids.length + 1);
  if (heads.length !== ids.length || new Set(heads.map(row => row.work?.value)).size !== ids.length) {
    throw new WorkReadUnavailable('Feed metadata heads are ambiguous');
  }
  const credits = new Map<string, ProjectedCredit[]>();
  for (const work of ids) credits.set(work, await primaryDiscoveryCredits(session, work));
  const names = await namedDiscoveryCredits(session, [...credits.values()].flat(), ids.length);
  for (const row of heads) {
    const work = row.work!.value;
    const header = readMetadataHeader(session, work, row.head?.value ?? null);
    const selected = selectedMetadata(await header, session.options.language);
    const metadataText = selected.tagline ?? selected.description;
    let excerpt = metadataText?.value.slice(0, 400) ?? null;
    let language = metadataText?.language ?? null;
    if (!excerpt) {
      const body = await session.query(`SELECT ?body ?language WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:mainVersion ?main . ?main rv:selectionHead ?selection .
          ?contribution rv:publicationHead ?decision . }
        GRAPH ${iri(GRAPHS.revisions)} { ?selection a rv:PublicationSelection ; rv:mainVersion ?main ;
          rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft ; rv:language ?language .
          ?decision rv:disclosure rv:Public ; rv:selectedDraft ?draft .
          FILTER NOT EXISTS { ?draft a rv:ErasedRevision } }
        GRAPH ${iri(PUBLIC_SEARCH_GRAPH)} { ?unit rv:selection ?selection ; rv:revision ?draft ; rv:searchBody ?body }
      } ORDER BY ?language LIMIT 65`, 65);
      if (body.length > 64) throw new WorkReadUnavailable('Feed Main preview exceeds language bound');
      const preferred = body.find(entry => entry.language?.value.toLowerCase() === session.options.language?.toLowerCase())
        ?? body.find(entry => entry.language?.value === 'en') ?? body[0];
      excerpt = preferred?.body?.value.slice(0, 400) ?? null;
      language = preferred?.language?.value ?? null;
    }
    const authors = (credits.get(work) ?? []).flatMap(credit => {
      if (!credit.agent) return [credit as DiscoveryCredit];
      const name = names.get(credit.agent);
      return name ? [{ ...credit, ...name } as DiscoveryCredit] : [];
    });
    result.set(work, { authors, excerpt, language });
  }
  return result;
}
