import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { publicWork } from '../work/public-patterns.ts';
import { ANONYMOUS_VIEWER } from '../suitability/policy.ts';
import { discloseInventory, DisclosureUnavailable } from './read.ts';
import { admittedPage, ADMITTED_PAGE_COST } from './admitted-page.ts';
import type { ReadRow } from '../work/read-session.ts';

export const SITEMAP_COST = {
  page: 500,
  graphQueries: ADMITTED_PAGE_COST.scans + 1,
  disclosureBatches: ADMITTED_PAGE_COST.scans + 8,
} as const;
export async function assembleSitemapEntries(
  env: WorkActivationEnvironment,
  rows: readonly { reference: string; revision: string }[],
) {
  if (rows.length > SITEMAP_COST.page + 1)
    throw new DisclosureUnavailable('Sitemap assembly exceeds its bound');
  const decisions = await discloseInventory(
    env,
    rows.map((row) => ({
      owner: 'graph' as const,
      resource: row.reference,
      component: 'name' as const,
      revision: row.revision,
      work: row.reference,
      workRevision: row.revision,
    })),
    ANONYMOUS_VIEWER,
    'sitemap',
  );
  return rows.flatMap((row, index) =>
    decisions[index] === 'visible'
      ? [{ reference: row.reference, preview: `/v1/public-previews/${row.reference.slice(-36)}` }]
      : [],
  );
}

/** Seek positions of hidden candidates never leave this reader. */
export async function readSitemap(env: WorkActivationEnvironment, after?: string) {
  let generation: string | undefined;
  const selected = await admittedPage<ReadRow>({
    limit: SITEMAP_COST.page,
    after: after ? { work: { type: 'uri', value: after } } : undefined,
    key: (row) => row.work!.value,
    fetch: async (seek, size) => {
      const rows =
        (
          await env.fuseki.query(
            `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?sequence ?work ?head WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      OPTIONAL { { SELECT ?work ?head WHERE {
        ${publicWork('?work', '?main')}
        GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head }
        ${seek ? `FILTER(STR(?work) > ${lit(seek.work!.value)})` : ''}
      } ORDER BY ?work LIMIT ${size} } }
    }`,
            262_144,
          )
        ).results?.bindings ?? [];
      const currentGeneration = rows[0]?.sequence?.value;
      const candidates = rows.filter((row) => row.work);
      if (
        !currentGeneration ||
        (generation && generation !== currentGeneration) ||
        candidates.some((row) => !row.head || row.sequence?.value !== currentGeneration) ||
        candidates.length > size ||
        new Set(candidates.map((row) => row.work!.value)).size !== candidates.length
      ) {
        throw new DisclosureUnavailable('Sitemap selection is unavailable');
      }
      generation = currentGeneration;
      return candidates;
    },
    admit: async (rows) => {
      const decisions = await discloseInventory(
        env,
        rows.map((row) => ({
          owner: 'graph',
          resource: row.work!.value,
          component: 'name',
          revision: row.head!.value,
          work: row.work!.value,
          workRevision: row.head!.value,
        })),
        ANONYMOUS_VIEWER,
        'sitemap',
      );
      return rows.filter((_, index) => decisions[index] === 'visible');
    },
  });
  const returned = [...selected.page, ...(selected.lookahead ? [selected.lookahead] : [])];
  const fenced = await assembleSitemapEntries(
    env,
    returned.map((row) => ({
      reference: row.work!.value,
      revision: row.head!.value,
    })),
  );
  if (fenced.length !== returned.length)
    throw new DisclosureUnavailable('Sitemap admission changed');
  const entries = fenced.slice(0, SITEMAP_COST.page);
  const current =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?sequence .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } } }`,
        8192,
      )
    ).results?.bindings ?? [];
  if (current.length !== 1 || current[0]?.sequence?.value !== generation) {
    throw new DisclosureUnavailable('Sitemap selection changed');
  }
  return {
    profile: 'public-sitemap-v1' as const,
    entries,
    next: selected.lookahead ? selected.last!.work!.value : null,
    generation: generation!,
  };
}
