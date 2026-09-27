import type { ContentCore } from '../../../../content/src/core.ts';
import { GRAPHS, RV, iri, type WorkActivationEnvironment } from '../work/activate.ts';

const revisionIri = /^urn:rezics:content:revision:([0-9a-f-]{36})$/;
const uuid = /^[0-9a-f-]{36}$/;
const digest = /^[0-9a-f]{64}$/;
const mediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export const REALM_MEDIA_COST = { maxItems: 16, maxContentBodyBytes: 1_048_576,
  adoptionExtraGraphReads: 1, adoptionExactContentReads: 1,
  servingGraphReads: 2, servingExactContentReads: 1,
  servingMediaRows: 1, servingObjectReads: 1 } as const;

export interface RealmMediaIntent { variantId: string; publicationDecision: string }
export interface RealmMediaReference extends RealmMediaIntent { revisionId: string; byteDigest: string }
export interface RealmMediaItem { use: string; sha256: string; mediaType: string;
  width: number; height: number }

export class RealmMediaUnavailable extends Error {}

/** One exact Content read, bounded by the media-set owner's 16-item limit and 1 MiB body limit. */
export async function readRealmMediaSet(content: Pick<ContentCore, 'readExactBatch'>,
  work: string, ref: RealmMediaReference): Promise<RealmMediaItem[]> {
  const exact = (await content.readExactBatch([ref.revisionId],
    async ids => new Set(ids)))[0];
  if (!exact || exact.status !== 'available' || exact.reference.resourceId !== work
    || exact.reference.variantId !== ref.variantId || exact.reference.revisionId !== ref.revisionId
    || exact.reference.model !== 'media-set-v1' || exact.reference.byteDigest !== ref.byteDigest
    || exact.reference.format !== 'rezics-content-json-v1'
    || exact.reference.language.kind !== 'zxx' || exact.reference.direction !== 'none'
    || exact.body.profile !== 'media-set-v1' || !Array.isArray(exact.body.items)
    || exact.body.items.length < 1 || exact.body.items.length > REALM_MEDIA_COST.maxItems) {
    throw new RealmMediaUnavailable('exact Realm media publication is unavailable');
  }
  const items: RealmMediaItem[] = [];
  const uses = new Set<string>();
  for (const value of exact.body.items) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new RealmMediaUnavailable('Realm media item is invalid');
    }
    const item = value as Record<string, unknown>;
    if (typeof item.use !== 'string' || !uuid.test(item.use) || uses.has(item.use)
      || typeof item.sha256 !== 'string' || !digest.test(item.sha256)
      || typeof item.mediaType !== 'string' || !mediaTypes.has(item.mediaType)
      || typeof item.width !== 'number' || !Number.isInteger(item.width) || item.width < 1
      || typeof item.height !== 'number' || !Number.isInteger(item.height) || item.height < 1) {
      throw new RealmMediaUnavailable('Realm media item is invalid');
    }
    uses.add(item.use);
    items.push({ use: item.use, sha256: item.sha256, mediaType: item.mediaType,
      width: item.width, height: item.height });
  }
  return items;
}

/** Adoption requires the current published decision; later source edits cannot move the selected bytes. */
export async function currentRealmMediaSet(env: WorkActivationEnvironment,
  content: Pick<ContentCore, 'readExactBatch'>, work: string,
  intent: RealmMediaIntent): Promise<{ reference: RealmMediaReference; items: RealmMediaItem[] }> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?digest WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(intent.variantId)} a rv:ContentVariant ; rv:resource ${iri(work)} ;
        rv:contentPublicationHead ${iri(intent.publicationDecision)} . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(intent.publicationDecision)} a rv:ContentPublicationDecision ;
        rv:component ${iri(intent.variantId)} ; rv:resource ${iri(work)} ;
        rv:contentModel "media-set-v1" ; rv:contentRevision ?revision ;
        rv:byteDigest ?digest . }
  }`)).results?.bindings ?? [];
  const match = revisionIri.exec(rows[0]?.revision?.value ?? '');
  const byteDigest = rows[0]?.digest?.value;
  if (rows.length !== 1 || !match || !byteDigest || !digest.test(byteDigest)) {
    throw new RealmMediaUnavailable('eligible Realm media publication is unavailable');
  }
  const reference = { ...intent, revisionId: match[1]!, byteDigest };
  return { reference, items: await readRealmMediaSet(content, work, reference) };
}
