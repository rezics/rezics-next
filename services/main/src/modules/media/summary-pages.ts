import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { MediaUnavailable } from './store.ts';
import type { SummaryReader } from './summary.ts';

export const SUMMARY_PAGE_COST = {
  batch: 64,
  graphQueries: 1,
  graphBytes: 64 * 1024,
  accessChecksPerResource: 3,
} as const;

/** One graph batch and at most three live Access decisions per page. Listing
 * affects discovery, never link readability. Repeat after name/media hydration. */
export async function readSummaryPages(
  env: WorkActivationEnvironment,
  resources: readonly string[],
  reader: SummaryReader,
  accessCheck: () => void,
): Promise<Map<string, boolean>> {
  const readable = new Map<string, boolean>();
  if (!resources.length) return readable;
  if (resources.length > SUMMARY_PAGE_COST.batch)
    throw new MediaUnavailable('Page summary batch exceeds its bound');
  const rows =
    (
      await env.fuseki.query(
        `PREFIX rv: <${RV}>
    SELECT DISTINCT ?resource ?space ?disclosure ?zoneDisclosure ?realm WHERE {
      VALUES ?resource { ${resources.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        { ?resource a rv:Space . BIND(?resource AS ?space) }
        UNION { ?resource a rv:Zone ; rv:zoneState rv:Active ; rv:space ?space ;
          rv:disclosure ?zoneDisclosure . }
        ?space a rv:Space ; rv:disclosure ?disclosure .
        OPTIONAL { ?space rv:realmCapability ?realm . ?realm rv:realmState rv:Active ; rv:space ?space }
        FILTER NOT EXISTS { ?resource rv:protectionHead ?protection }
        FILTER NOT EXISTS { ?space rv:protectionHead ?spaceProtection }
      }
    } LIMIT ${resources.length + 1}`,
        SUMMARY_PAGE_COST.graphBytes,
      )
    ).results?.bindings ?? [];
  const seen = new Set<string>();
  for (const row of rows) {
    const resource = row.resource?.value,
      space = row.space?.value;
    if (
      !resource ||
      !space ||
      !resources.includes(resource) ||
      seen.has(resource) ||
      ![RV + 'Public', RV + 'Private'].includes(row.disclosure?.value ?? '') ||
      (row.zoneDisclosure && ![RV + 'Public', RV + 'Private'].includes(row.zoneDisclosure.value))
    ) {
      throw new MediaUnavailable('Page summary visibility is ambiguous');
    }
    seen.add(resource);
    const publicSpace = row.disclosure!.value === RV + 'Public';
    let spaceReadable = publicSpace;
    if (!spaceReadable && reader.canReadSemantic) {
      accessCheck();
      spaceReadable = await reader.canReadSemantic(space);
    }
    if (!spaceReadable && row.realm && reader.realmReadProof) {
      accessCheck();
      spaceReadable = !!(await reader.realmReadProof(row.realm.value));
    }
    if (!spaceReadable) continue;
    const publicZone = !row.zoneDisclosure || row.zoneDisclosure.value === RV + 'Public';
    if (!publicZone) {
      if (!reader.canReadSemantic) continue;
      accessCheck();
      if (!(await reader.canReadSemantic(resource))) continue;
    }
    readable.set(resource, publicSpace && publicZone);
  }
  return readable;
}
