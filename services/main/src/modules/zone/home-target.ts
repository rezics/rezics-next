import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';
import { readResourceVisibility, type VisibilityReader } from '../space/visibility.ts';
import { captureHomeDisclosureFence } from './home-disclosure-fence.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';
import type { Viewer } from '../suitability/policy.ts';
import { readZoneSitePublicationReceipt, ZoneUnavailable } from './configuration.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const ZONE_HOME_TARGET_COST = { ownerRows: 2, cutRows: 2, ownerBytes: 8192 } as const;

async function homeOwner(env: WorkActivationEnvironment, resource: string) {
  if (!native.test(resource)) return null;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT DISTINCT ?zone ?head ?typed ?space ?author ?realm WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        OPTIONAL { ?zone a rv:Zone ; rv:homeDocument ${iri(resource)} ; rv:space ?space .
          OPTIONAL { ?space rv:owner ?author }
          OPTIONAL { ?zone rv:defaultRealm ?realm } }
        OPTIONAL { ${iri(resource)} rv:homeDocumentHead ?head }
        BIND(EXISTS { ${iri(resource)} a rv:ZoneHomeDocument } AS ?typed)
        FILTER(?typed || BOUND(?zone))
      }
    } LIMIT ${ZONE_HOME_TARGET_COST.ownerRows}`, ZONE_HOME_TARGET_COST.ownerBytes)).results?.bindings ?? [];
  if (!rows.length) return null;
  // A typed orphan is recognized without granting a Work fallback.
  const owners = rows.filter(row => row.zone);
  if (owners.length !== 1 || !native.test(owners[0]!.zone!.value)
    || owners[0]!.zone!.value === resource || rows.length > ZONE_HOME_TARGET_COST.ownerRows
    || rows.some(row => row.head?.value !== owners[0]!.head?.value
      || row.typed?.value !== owners[0]!.typed?.value)) {
    throw new ZoneUnavailable('Home document ownership is unavailable');
  }
  const row = owners[0]!;
  return { zone: row.zone!.value, head: row.head?.value, typed: row.typed?.value === 'true',
    space: row.space?.value,
    author: row.author?.value, realm: row.realm?.value };
}

/** A reservation remains recognizable before P's first native publication. */
export async function readZoneHomeOwner(env: WorkActivationEnvironment, resource: string): Promise<string | null> {
  return (await homeOwner(env, resource))?.zone ?? null;
}

export interface ZoneHomeTarget {
  resource: string;
  revision: string;
  zone: string;
  disclosure: 'public' | 'restricted';
  space: string | null;
  author?: string;
  realm: string | null;
  selections: { revisionId: string; variantId: string; byteDigest: string; language?: string }[];
}

/** Only a retained native cut with its successful owning-site receipt is nameable.
 * Content draft heads and later language selections never enter this proof. */
export async function readZoneHomeTarget(env: WorkActivationEnvironment, resource: string,
  revision?: string, reader: VisibilityReader = {}, viewer: Viewer = currentDisclosureViewer()): Promise<ZoneHomeTarget | null> {
  const owner = await homeOwner(env, resource);
  if (!owner?.typed) return null;
  const cut = revision ?? owner.head;
  if (!cut || !native.test(cut)) return null;
  const visibility = await readResourceVisibility(env, owner.zone, reader);
  if (!visibility?.readable) return null;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT ?receipt ?siteRevision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(owner.zone)} a rv:Zone ; rv:zoneState rv:Active ;
      rv:homeDocument ${iri(resource)} . ${iri(resource)} a rv:ZoneHomeDocument . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(cut)} a rv:ZoneHomeRevision, rv:RevisionAnchor ; rv:component ${iri(resource)} .
      ?siteRevision a rv:ZoneRevision ; rv:component ${iri(owner.zone)} ;
        rv:homeDocument ${iri(resource)} ; rv:homeRevision ${iri(cut)} ; rv:sitePublicationReceipt ?receipt .
      FILTER NOT EXISTS { ${iri(cut)} a rv:ErasedRevision }
      FILTER NOT EXISTS { ${iri(cut)} rv:publishedPage ?selected .
        ?selected rv:contentRevision ?content . ?content a rv:ErasedRevision }
    }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt a rv:OperationReceipt ; rv:outcome rv:Succeeded ;
      rv:structureOwner ${iri(owner.zone)} ; rv:sitePublicationRevision ?siteRevision ;
      rv:homeDocument ${iri(resource)} ; rv:homeRevision ${iri(cut)} . }
  } LIMIT ${ZONE_HOME_TARGET_COST.cutRows}`, ZONE_HOME_TARGET_COST.ownerBytes)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.receipt?.value || !rows[0]?.siteRevision?.value) return null;
  const receipt = await readZoneSitePublicationReceipt(env, rows[0].receipt.value);
  if (!receipt || receipt.homeErased || receipt.zone !== owner.zone || receipt.homeDocument !== resource
    || receipt.homeRevision !== cut || receipt.revision !== rows[0].siteRevision.value
    || !receipt.pages.length || receipt.pages.some(page => page.page !== resource || !page.byteDigest)) return null;
  const fence = await captureHomeDisclosureFence(env, [{ resource, zone: owner.zone,
    targets: [{ owner: 'graph', resource, revision: cut, component: 'record' },
      ...receipt.pages.map(page => ({ owner: 'content' as const, resource, revision: page.revisionId,
        component: 'body' as const, occurrence: { owner: 'graph' as const, kind: 'publication' as const, resource, revision: cut } }))],
  }], viewer, 'read');
  const target: ZoneHomeTarget = { resource, revision: cut, zone: owner.zone,
    disclosure: visibility.visibility === 'private' ? 'restricted' : 'public',
    space: visibility.space, ...(owner.author ? { author: owner.author } : {}),
    realm: owner.realm ?? visibility.realm,
    selections: receipt.pages.map(page => ({ revisionId: page.revisionId, variantId: page.variantId,
      byteDigest: page.byteDigest!, ...(page.language ? { language: page.language } : {}) })) };
  const visible = await fence(async () => {
    const current = await readResourceVisibility(env, owner.zone, reader);
    return new Set(current?.readable && current.visibility === visibility.visibility
      && current.space === visibility.space && current.realm === visibility.realm ? [owner.zone] : []);
  });
  return visible.has(resource) ? target : null;
}
