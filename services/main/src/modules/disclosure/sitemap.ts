import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import { discloseInventory, DisclosureUnavailable } from './read.ts';

export const SITEMAP_COST = { page: 500, graphQueries: 2, disclosureBatches: 8 } as const;
export async function assembleSitemapEntries(env: WorkActivationEnvironment,
  rows: readonly { reference: string; revision: string }[]) {
  if (rows.length > SITEMAP_COST.page) throw new DisclosureUnavailable('Sitemap assembly exceeds its bound');
  const decisions = await discloseInventory(env, rows.map(row => ({ owner: 'graph' as const,
    resource: row.reference, component: 'name' as const, revision: row.revision })), ANONYMOUS_VIEWER, 'sitemap');
  return rows.flatMap((row, index) => decisions[index] === 'visible'
    ? [{ reference: row.reference, preview: `/v1/public-previews/${row.reference.slice(-36)}` }] : []);
}

/** The cursor advances over selected candidates even if the whole page is hidden. */
export async function readSitemap(env: WorkActivationEnvironment, after?: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?sequence ?work ?head WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      OPTIONAL { { SELECT ?work ?head WHERE {
        ${publicWork('?work', '?main')}
        GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head }
        ${after ? `FILTER(STR(?work) > ${lit(after)})` : ''}
      } ORDER BY ?work LIMIT ${SITEMAP_COST.page + 1} } }
    }`, 262_144)).results?.bindings ?? [];
  const generation = rows[0]?.sequence?.value;
  const candidates = rows.filter(row => row.work);
  if (!generation || candidates.some(row => !row.head || row.sequence?.value !== generation)
    || candidates.length > SITEMAP_COST.page + 1
    || new Set(candidates.map(row => row.work!.value)).size !== candidates.length) {
    throw new DisclosureUnavailable('Sitemap selection is unavailable');
  }
  const page = candidates.slice(0, SITEMAP_COST.page).map(row => ({
    reference: row.work!.value, revision: row.head!.value,
  }));
  const entries = await assembleSitemapEntries(env, page);
  const current = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } }`, 8192)).results?.bindings ?? [];
  if (current.length !== 1 || current[0]?.sequence?.value !== generation) {
    throw new DisclosureUnavailable('Sitemap selection changed');
  }
  return { profile: 'public-sitemap-v1' as const, entries,
    next: candidates.length > SITEMAP_COST.page ? page.at(-1)!.reference : null, generation };
}
