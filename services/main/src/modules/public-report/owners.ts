import type { Pool } from 'pg';
import { identityKeyUuid } from '@rezics/model/address/sid';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { readMergedIdentity } from '../identity-merge/resolution.ts';
import { captureReplyEvidence, ownerEvidenceCapture } from '../governance/evidence.ts';
import { capturePublishedHomeEvidence } from '../governance/composition.ts';
import { GovernanceDenied, GovernanceInvalid, GovernanceUnavailable, type EvidenceTarget } from '../governance/store.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { resolveTargets, type ReportTargets } from '../target/resolve.ts';
import type { ResolvedTarget } from '../target/contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { workRead, WorkReadMissing, type WorkReadSession } from '../work/read-session.ts';
import { RealmReplyContentStore } from '../realm-reply/content-store.ts';
import { RealmReplyStore } from '../realm-reply/store.ts';
import { avatarImageEligible, DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import type { PublicReportOwners } from './store.ts';
import { readZoneHomeOwner } from '../zone/home-target.ts';

const ID = 'https://rezics.com/id/';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const contentRevision = /^urn:rezics:content:revision:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** A revision URL is a selector only; its Content owner supplies the resource. */
function contentRevisionAddress(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== 'https://rezics.com' || !url.pathname.startsWith('/v1/content-revisions/')) return null;
  if (url.username || url.password || url.search || url.hash) {
    throw new GovernanceInvalid('Content revision URL must name one exact revision');
  }
  const match = /^\/v1\/content-revisions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
  if (!match) throw new GovernanceInvalid('Invalid Content revision URL');
  return match[1]!;
}

/** Resolve service-owned URLs locally. Never fetch a caller's URL. */
async function resolvedReportAddress(deps: MainWorkDependencies, value: string):
  Promise<{ resource: string; homeRevision?: string }> {
  if (native.test(value)) return { resource: value };
  let url: URL;
  try { url = new URL(value); } catch { throw new GovernanceInvalid('Invalid target URL'); }
  if (url.origin !== 'https://rezics.com' || url.username || url.password || url.search || url.hash) {
    throw new GovernanceInvalid('Target URL must name a REZICS resource');
  }
  const id = /^\/(?:v1\/)?(?:resources|works|agents|realms|media\/assets|posts|replies)\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (id) return { resource: ID + id[1] };
  const entity = /^\/e\/([^/]+)$/.exec(url.pathname);
  if (entity) {
    let segment: string;
    try { segment = decodeURIComponent(entity[1]!); } catch { throw new GovernanceInvalid('Invalid REZICS resource address'); }
    const uuid = identityKeyUuid(segment);
    if (!uuid) throw new GovernanceInvalid('Invalid REZICS resource address');
    return { resource: ID + uuid };
  }
  const site = /^\/z\/([^/]+)$/.exec(url.pathname);
  if (site) {
    let segment: string;
    try { segment = decodeURIComponent(site[1]!); } catch { throw new GovernanceInvalid('Invalid Zone address'); }
    const uuid = identityKeyUuid(segment);
    const address = uuid ? null : await deps.environment.addresses?.identify('space', segment);
    const space = uuid ? ID + uuid : address?.alias?.state === 'retired' ? null : address?.holder;
    if (!space) throw new GovernanceDenied('Target is unavailable');
    const rows = (await deps.environment.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT DISTINCT ?resource ?revision WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?zone a rv:Zone ; rv:zoneState rv:Active ;
          rv:space ${iri(space)} ; rv:homeDocument ?resource .
          ?resource a rv:ZoneHomeDocument ; rv:homeDocumentHead ?revision }
        GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ZoneHomeRevision ; rv:component ?resource .
          FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
      } LIMIT 2`, 8192)).results?.bindings ?? [];
    if (rows.length !== 1 || !rows[0]?.resource?.value || !rows[0]?.revision?.value) {
      throw new GovernanceDenied('Target is unavailable');
    }
    return { resource: rows[0].resource.value, homeRevision: rows[0].revision.value };
  }
  const segment = /^\/(?:w|work)\/([^/]+)$/.exec(url.pathname);
  if (!segment) throw new GovernanceInvalid('Unsupported REZICS target URL');
  const address = await deps.environment.addresses?.identify('work',decodeURIComponent(segment[1]!));
  if (!address?.holder || address.alias?.state === 'retired') throw new GovernanceDenied('Target is unavailable');
  // Reporting's reader and evidence owners admit private Works below. URL
  // identification must not impose the public resolver's anonymous disclosure.
  const resolution = await readMergedIdentity(deps.environment,address.holder,async () => true);
  return { resource: resolution?.survivor ?? address.holder };
}

/** The string form remains useful to callers that do not capture evidence. */
export async function reportAddress(deps: MainWorkDependencies, value: string): Promise<string> {
  return (await resolvedReportAddress(deps, value)).resource;
}

/** One bounded Content batch and one graph batch supplement G-506's summary
 * owner. Reporting accepts every admitted base and does not require a type. */
function reportOwnerTargets(content: Pool): ReportTargets {
  return async (session, resources) => {
    const targets = new Map<string, ResolvedTarget>();
    const readMedia = async () => (await content.query<{ id: string; draft_head: string }>(`SELECT a.id::text, v.draft_head::text
      FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
      JOIN content.variant v ON v.id = a.variant_id
      JOIN content.revision r ON r.id = v.draft_head WHERE a.id = ANY($1::uuid[])
      AND s.disclosure = 'public' AND s.lifecycle = 'active' AND r.availability = 'available' ORDER BY a.id`,
    [resources.map(resource => resource.slice(-36))])).rows;
    const media = await readMedia();
    session.observeDependency(`report-media-targets:${JSON.stringify(resources)}`, media, readMedia);
    for (const row of media) targets.set(ID + row.id, { resource: ID + row.id, revision: ID + row.draft_head,
      base: 'resource', types: ['https://rezics.com/vocab/MediaAsset'], work: null, disclosure: 'public' });
    const rows = await session.query(`SELECT ?r ?revision ?type WHERE {
      VALUES ?r { ${resources.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} {
        { ?r a rv:Agent ; rv:head ?initial ; rv:profileDisclosure rv:Public .
          OPTIONAL { ?r rv:publicProfileHead ?profile }
          BIND(COALESCE(?profile, ?initial) AS ?revision) BIND(rv:Agent AS ?type) }
        UNION { ?r a rv:Space ; rv:head ?revision ; rv:disclosure rv:Public . BIND(rv:Space AS ?type) }
        UNION { ?r a skos:Concept ; rv:head ?revision ; rv:conceptState rv:Active .
          FILTER NOT EXISTS { ?r rv:conceptState rv:Retired } BIND(skos:Concept AS ?type) }
        UNION { ?r a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space rv:realmCapability ?r .
          OPTIONAL { ?r rv:publicProfileHead ?profile }
          OPTIONAL { ?r rv:head ?realmHead }
          BIND(COALESCE(?profile, ?realmHead) AS ?revision) BIND(rv:Realm AS ?type) }
      }
      FILTER(BOUND(?revision))
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r rv:protectionHead ?protection } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?r a rv:AgentTombstone } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
    } LIMIT ${resources.length * 2 + 1}`, resources.length * 2);
    for (const row of rows) {
      if (!row.r || !row.revision || targets.has(row.r.value)) throw new GovernanceUnavailable('Report target is ambiguous');
      const policy = row.type?.value === 'https://rezics.com/vocab/Realm' ? await session.realm(row.r.value) : null;
      targets.set(row.r.value, { resource: row.r.value, revision: row.revision.value, base: 'resource',
        types: [row.type!.value], work: null, disclosure: policy?.visibility === 'private' ? 'restricted' : 'public' });
    }
    return targets;
  };
}

/** Current public eligibility binds one exact Content revision to its variant. */
async function publicContentPublication(session: WorkReadSession, resource: string, revision: string) {
  const revisionIri = `urn:rezics:content:revision:${revision}`;
  const rows = await session.query(`SELECT ?variant ?model WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ${iri(resource)} ;
      rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?publication a rv:ContentPublicationDecision ; rv:component ?variant ; rv:resource ${iri(resource)} ;
        rv:contentRevision ${iri(revisionIri)} ; rv:contentModel ?model .
      ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ?publication ;
        rv:disclosure rv:Public .
      FILTER NOT EXISTS { ${iri(revisionIri)} a rv:ErasedRevision }
    }
  } LIMIT 2`, 2);
  if (rows.length > 1 || rows.some(row => !row.variant?.value || !row.model?.value)) {
    throw new GovernanceUnavailable('Content publication mapping is ambiguous');
  }
  const row = rows[0];
  return row ? { variant: row.variant!.value, model: row.model!.value } : null;
}

async function authorAndRealm(session: WorkReadSession, resource: string, work: string | null,
  content: Pool): Promise<{ author: string | null; realm: string | null }> {
  const rows = await session.query(`SELECT ?author ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      { ${iri(resource)} rv:author ?author }
      UNION { ?credit a rv:NativeAgentCredit ; rv:work ${iri(work ?? resource)} ;
        rv:agent ?author . }
      UNION { ${iri(resource)} a rv:Agent . BIND(${iri(resource)} AS ?author) }
      UNION { ${iri(resource)} a rv:Realm ; rv:space ?space . ?space rv:owner ?author }
      UNION { ${iri(resource)} a rv:Space ; rv:owner ?author }
      OPTIONAL { ${iri(resource)} rv:realm ?realm }
    }
  } ORDER BY ?credit ?author LIMIT 1`, 1);
  const media = (await content.query<{ owner: string }>('SELECT owner FROM media.asset WHERE id = $1',
    [resource.slice(-36)])).rows[0];
  const reply = (await content.query<{ author: string; origin_realm: string | null }>(
    'SELECT author, origin_realm FROM content.reply_author WHERE reply = $1', [resource])).rows[0];
  const ownRealm = rows[0]?.realm?.value ?? null;
  return { author: media?.owner ?? reply?.author ?? rows[0]?.author?.value ?? null,
    realm: reply?.origin_realm ?? ownRealm };
}

export function publicReportOwners(deps: MainWorkDependencies, contentPool: Pool,
  core: ContentCore): PublicReportOwners {
  const replyOwner = { pool: contentPool, core,
    reader: new RealmReplyStore(new RealmReplyContentStore(contentPool), core, deps.access, deps.environment) };
  const capture = ownerEvidenceCapture({ graph: { env: deps.environment, canReadWork: async () => false },
    content: { core, canRead: async () => new Set() },
    ...(deps.media ? { media: { pool: contentPool,
      canReadWork: (principal, actingSubject, work) => deps.access.canReadWork(principal, actingSubject, work),
      isServedAvatar: async (work, use) => {
        const snapshot = await deps.media!.store.avatarRows([work], DEFAULT_MEDIA_CONTEXT);
        const avatar = snapshot.rows.get(work);
        return avatar?.context === DEFAULT_MEDIA_CONTEXT && avatar.use === use && avatarImageEligible(avatar);
      },
    } } : {}) });
  return {
    async resolve(input, request, principal) {
      const revisionAddress = contentRevisionAddress(input.target);
      if (revisionAddress && input.selection) {
        throw new GovernanceInvalid('Content revision URL cannot be combined with a selection');
      }
      const selectedSelectionRevision = input.selection && ['body', 'media_use'].includes(input.selection.component)
        ? contentRevision.exec(input.selection.revision)?.[1] ?? null : null;
      if (input.selection && ['body', 'media_use'].includes(input.selection.component) && !selectedSelectionRevision)
        throw new GovernanceInvalid('Content revision selection is invalid');
      const selectedRevision = revisionAddress ?? (input.selection?.component === 'body'
        ? selectedSelectionRevision : null);
      let selectedMediaRevision = input.selection?.component === 'media_use' ? selectedSelectionRevision : null;
      let selectedMediaUse = input.selection?.component === 'media_use' ? input.selection.locator : null;
      const addressed = revisionAddress ? null : await resolvedReportAddress(deps, input.target);
      const requestedResource = addressed?.resource ?? null;
      if (input.selection?.component === 'cover') {
        if (!deps.media) throw new GovernanceUnavailable('Media owner is unavailable');
        const avatar = await deps.media.store.avatarDelivery(input.selection.revision);
        if (!avatar || avatar.target !== requestedResource || !avatarImageEligible(avatar))
          throw new GovernanceDenied('Reported Work cover is unavailable');
        const use = (await contentPool.query<{ revision: string }>(
          'SELECT asset_revision_id::text AS revision FROM media.use WHERE id=$1', [avatar.use])).rows[0];
        if (!use) throw new GovernanceDenied('Reported Work cover is unavailable');
        selectedMediaRevision = use.revision;
        selectedMediaUse = avatar.use;
      }
      let contentResource: string | null = null;
      if (selectedRevision) {
        contentResource = await core.owningResourceForRevision(selectedRevision)
          .catch(() => { throw new GovernanceUnavailable('Content owner is unavailable'); });
        if (!contentResource) throw new GovernanceDenied('Target is unavailable');
        if (requestedResource && requestedResource !== contentResource) {
          if (await readZoneHomeOwner(deps.environment, contentResource)) throw new GovernanceDenied('Target is unavailable');
          throw new GovernanceInvalid('Content revision belongs to another resource');
        }
      }
      const resource = contentResource ?? requestedResource!;
      const headers = new Headers(request.headers);
      // Invalid/suspended assertions and optional sign-in must never close intake.
      // Only an explicitly represented reader uses a private target read.
      if (!principal || !input.actingSubject) headers.delete('authorization');
      const reading = new Request(request.url, { method: 'POST', headers });
      const resolve = async (session: WorkReadSession) => {
          const homeEvidence = await capturePublishedHomeEvidence(deps.environment, core, deps.access,
            session.principal, session.options.actingSubject, { owner: selectedMediaRevision ? 'media'
              : selectedRevision ? 'content' : 'graph', resource,
            component: selectedMediaRevision ? 'media_use' : selectedRevision ? 'body' : 'record',
            revision: selectedRevision ?? addressed?.homeRevision ?? null,
            locator: input.selection?.locator ?? null }, true, addressed?.homeRevision);
          if (homeEvidence) {
            return { evidence: homeEvidence, author: homeEvidence.provenance.author ?? null,
              realm: homeEvidence.provenance.realm ?? null };
          }
          if (selectedMediaRevision && selectedMediaUse) {
            const [target] = await resolveTargets(session, [resource], 'report', undefined, reportOwnerTargets(contentPool));
            if (!target) throw new GovernanceDenied('Media target is unavailable');
            if (target.base !== 'work' || target.work !== resource || target.resource !== resource
              || target.types.includes('https://rezics.com/vocab/MediaAsset')) {
              throw new GovernanceInvalid('Media use selection requires an ordinary Work cover');
            }
            const actor = session.options.actingSubject;
            const readable = target.disclosure === 'public' || !!session.principal && !!actor
              && await deps.access.canReadWork(session.principal, actor, resource);
            if (!readable) throw new GovernanceDenied('reporter cannot read the reported Work cover');
            if (!deps.media) throw new GovernanceUnavailable('Media owner is unavailable');
            const evidence = await capture.admitted({ owner: 'media', resource, component: 'media_use',
              revision: selectedMediaRevision, locator: selectedMediaUse },
            { actingSubject: actor, mediaWorkRead: true, requireServedAvatar: true });
            if (evidence.state !== 'available') throw new GovernanceDenied('Reported Work cover is unavailable');
            const attribution = await authorAndRealm(session, resource, target.work, contentPool);
            return { evidence, ...attribution };
          }
          if (selectedRevision) {
            const [target] = await resolveTargets(session, [resource], 'report', undefined, reportOwnerTargets(contentPool));
            if (!target) throw new GovernanceDenied('Content target is unavailable');
            if (target.base !== 'work' || target.work !== resource || target.resource !== resource
              || target.types.includes('https://rezics.com/vocab/MediaAsset')) {
              throw new GovernanceInvalid('Content selection requires an ordinary Work body');
            }
            const publication = await publicContentPublication(session, resource, selectedRevision);
            const publiclyReadable = target.disclosure === 'public' && publication !== null;
            const actor = session.options.actingSubject;
            if (!publiclyReadable && (!session.principal || !actor
              || !await deps.access.canReadWork(session.principal, actor, resource))) {
              throw new GovernanceDenied('reporter cannot read the reported Content revision');
            }
            if (publication && ['media-set-v1', 'member-reply-v1'].includes(publication.model)) {
              throw new GovernanceInvalid('Content selection does not name an ordinary body');
            }
            const [exact] = await core.readExactBatch([selectedRevision], async ids => new Set(ids))
              .catch(() => { throw new GovernanceUnavailable('Content owner is unavailable'); });
            if (!exact || exact.status === 'denied') {
              throw new GovernanceDenied('reporter cannot read the reported Content revision');
            }
            if (exact.status === 'available') {
              if (exact.reference.resourceId !== resource) {
                throw new GovernanceInvalid('Content revision belongs to another resource');
              }
              if (publication && exact.reference.variantId !== publication.variant) {
                throw new GovernanceUnavailable('Content publication differs from its owner revision');
              }
              if (['media-set-v1', 'member-reply-v1'].includes(exact.reference.model)) {
                throw new GovernanceInvalid('Content selection does not name an ordinary body');
              }
            }
            const evidence = await capture.admitted({ owner: 'content', resource,
              component: 'body', revision: selectedRevision, locator: null });
            const attribution = await authorAndRealm(session, resource, target.work, contentPool);
            return { evidence, ...attribution };
          }
          const reply = await captureReplyEvidence(replyOwner, { owner: 'content', component: 'body',
            resource, revision: null, locator: null }, session.principal, session.options.actingSubject, true);
          if (reply) return { evidence: reply, author: reply.provenance.author!,
            realm: reply.provenance.realm === 'urn:rezics:context:global' ? null : reply.provenance.realm! };
          const [target] = await resolveTargets(session, [resource], 'report', undefined, reportOwnerTargets(contentPool));
          if (!target) throw new GovernanceDenied('Target is unavailable');
          if (input.selection?.component === 'synopsis') {
            if (target.base !== 'work' || target.resource !== resource || target.revision !== input.selection.revision)
              throw new GovernanceInvalid('Synopsis selection must name the current Work revision');
            if ((await session.disclosure([{ owner: 'graph', resource, component: 'synopsis' }]))[0] !== 'visible')
              throw new GovernanceDenied('Synopsis is unavailable');
            const evidence = await capture.admitted({ owner: 'graph', resource, component: 'synopsis',
              revision: input.selection.revision, locator: null });
            if (evidence.state !== 'available') throw new GovernanceDenied('Synopsis is unavailable');
            return { evidence, ...await authorAndRealm(session, resource, target.work, contentPool) };
          }
          const contentOwned = target.types.includes('https://rezics.com/vocab/MediaAsset');
          const evidenceTarget: EvidenceTarget = contentOwned
            ? { owner: 'content', component: 'body', resource, revision: target.revision.slice(-36), locator: null }
            : { owner: 'graph', component: target.base === 'work' ? 'title' : 'record',
              resource, revision: target.revision, locator: null };
          const attribution = await authorAndRealm(session, resource, target.work, contentPool);
          return { evidence: await capture.admitted(evidenceTarget), ...attribution,
            realm: target.types.includes('https://rezics.com/vocab/Realm') ? resource : attribution.realm };
        };
      try {
        return await workRead(deps, reading, principal && input.actingSubject ? { actingSubject: input.actingSubject } : {}, resolve);
      } catch (error) {
        if (error instanceof WorkReadMissing) throw new GovernanceDenied('Target is unavailable');
        if (!(error instanceof AccountAssertionDenied)) throw error;
        headers.delete('authorization');
        return workRead(deps, new Request(request.url, { method: 'POST', headers }), {}, resolve)
          .catch(error => { if (error instanceof WorkReadMissing) throw new GovernanceDenied('Target is unavailable'); throw error; });
      }
    },
  };
}
