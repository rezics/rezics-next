import { createHash } from 'node:crypto';
import type { FusekiClient, SourceAuthorNamesRequest } from '../../infrastructure/fuseki.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { SourceIntakeUnavailable } from './intake.ts';
import { canonicalLanguage } from '../display-language/select.ts';

export const SOURCE_NAME_PUBLICATION_COST = { works: 64, credits: 128,
  responseBytes: 65_536 } as const;
interface NameHead { sourcePosition: string; name: { displayName: string; language?: string | null } | null }
interface NameReader { read(author: string): Promise<NameHead | null> }
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

/** Publication pages the reverse credit relation; the native writer receives
 * exact credit identities and never discovers credits through a corpus scan.
 * Replays reread the current source head, repairing a commit/transport gap. */
export async function publishSourceAuthorName(fuseki: Pick<FusekiClient, 'query' | 'sourceAuthorNames'>,
  reader: NameReader, sourceKey: string, target?: string) {
  try { await publishPages(fuseki, reader, sourceKey, target); }
  catch (error) {
    if (error instanceof SourceIntakeUnavailable) throw error;
    throw new SourceIntakeUnavailable('Source author native publication is incomplete', { cause: error });
  }
}

async function publishPages(fuseki: Pick<FusekiClient, 'query' | 'sourceAuthorNames'>,
  reader: NameReader, sourceKey: string, target?: string) {
  let after = '';
  do {
    const works = target ? [target] : (await fuseki.query(`PREFIX rv: <${RV}>
      PREFIX schema: <https://schema.org/>
      SELECT DISTINCT ?work WHERE { GRAPH ${iri(GRAPHS.current)} {
        ?credit a rv:AuthorCredit ; rv:work ?work ; rv:externalKey ${lit(sourceKey)} ;
          rv:externalProvider "open-library" ; rv:externalNamespace "author" ; schema:roleName "author" .
        FILTER NOT EXISTS { ?credit rv:retiredBy ?retirement }
        FILTER(STR(?work) > ${lit(after)})
      } } ORDER BY ?work LIMIT ${SOURCE_NAME_PUBLICATION_COST.works + 1}`,
    SOURCE_NAME_PUBLICATION_COST.responseBytes)).results?.bindings.map(row => row.work?.value ?? '') ?? [];
    if (works.some(work => !native.test(work)) || new Set(works).size !== works.length
      || works.some((work, index) => work <= after || (index > 0 && work <= works[index - 1]!))) {
      throw new SourceIntakeUnavailable('Source name publication Work page is malformed');
    }
    for (const work of works.slice(0, SOURCE_NAME_PUBLICATION_COST.works)) {
      const rows = (await fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        SELECT DISTINCT ?credit WHERE { GRAPH ${iri(GRAPHS.current)} {
          ?credit a rv:AuthorCredit ; rv:work ${iri(work)} ; rv:externalKey ${lit(sourceKey)} ;
            rv:creditRevision ?revision ; rv:externalProvider "open-library" ;
            rv:externalNamespace "author" ; schema:roleName "author" .
          FILTER NOT EXISTS { ?credit rv:retiredBy ?retirement }
        } } ORDER BY ?credit LIMIT ${SOURCE_NAME_PUBLICATION_COST.credits + 1}`,
      SOURCE_NAME_PUBLICATION_COST.responseBytes)).results?.bindings ?? [];
      const credits = rows.map(row => row.credit?.value ?? '');
      if (credits.length > SOURCE_NAME_PUBLICATION_COST.credits || credits.some(credit => !native.test(credit))) {
        throw new SourceIntakeUnavailable('Source name publication credits exceed their bound');
      }
      // Reading immediately before dispatch also makes an old API replay publish
      // the current name, rather than reviving the replayed revision's label.
      const head = await reader.read(sourceKey);
      if (!head) continue;
      const payload = { target: work, sourceKey, sourcePosition: head.sourcePosition, credits,
        names: head.name ? [{ sourceKey, displayName: head.name.displayName, language: head.name.language ?? null }] : [] };
      if (payload.names.some(name => name.language !== null && !canonicalLanguage(name.language))) {
        throw new SourceIntakeUnavailable('Source name publication language is invalid');
      }
      const idempotencyKey = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      await fuseki.sourceAuthorNames({ ...payload, idempotencyKey } satisfies SourceAuthorNamesRequest);
    }
    if (target || works.length <= SOURCE_NAME_PUBLICATION_COST.works) return;
    after = works[SOURCE_NAME_PUBLICATION_COST.works - 1]!;
  } while (true);
}
