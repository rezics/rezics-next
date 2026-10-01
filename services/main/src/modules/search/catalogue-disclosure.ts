import { discloseSearchMatches } from '../disclosure/search.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { PublicQueryUnavailable } from '../work/search-budget.ts';
import type { SearchFieldOwners } from './fields.ts';
import type { RankedCatalogueMatch } from './ranked.ts';

/** Apply the same name/body audience gate and exact-head governance fence as
 * other search surfaces before a candidate affects public pages or counts. */
export async function discloseCatalogueMatches(env: WorkActivationEnvironment, rows: RankedCatalogueMatch[],
  restrictedTitles?: SearchFieldOwners['restrictedTitles'], context = 'urn:rezics:semantic-context:global') {
  const disclosed = await discloseSearchMatches(env, rows);
  if (!restrictedTitles || !disclosed.length) return disclosed;
  const works = [...new Set(disclosed.map(row => row.work))];
  const heads = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?work ?head WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head }
  } LIMIT ${works.length + 1}`, 65_536)).results?.bindings ?? [];
  if (heads.length !== works.length || new Set(heads.map(row => row.work?.value)).size !== works.length
    || heads.some(row => !row.work || !row.head || !works.includes(row.work.value))) {
    throw new PublicQueryUnavailable('Catalogue name disclosure heads are incomplete');
  }
  const denied = await restrictedTitles(heads.map(row => ({ work: row.work!.value, revision: row.head!.value })), context);
  return disclosed.filter(row => !denied.has(row.work));
}
