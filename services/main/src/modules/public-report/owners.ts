import type { Pool } from 'pg';
import type { ContentCore } from '../../../../content/src/core.ts';
import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import { readMergedIdentity } from '../identity-merge/resolution.ts';
import { ownerEvidenceCapture } from '../governance/evidence.ts';
import { GovernanceDenied, GovernanceInvalid, GovernanceUnavailable, type EvidenceTarget } from '../governance/store.ts';
import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { resolveTargets, type ReportTargets } from '../target/resolve.ts';
import type { ResolvedTarget } from '../target/contract.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { workRead, type WorkReadSession } from '../work/read-session.ts';
import { publicWork } from '../work/public-patterns.ts';
import type { PublicReportOwners } from './store.ts';

const ID = 'https://rezics.com/id/';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** Resolve service-owned URLs locally. Never fetch a caller's URL. */
export async function reportAddress(deps: MainWorkDependencies, value: string): Promise<string> {
  if (native.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new GovernanceInvalid('Invalid target URL'); }
  if (url.origin !== 'https://rezics.com' || url.username || url.password || url.search || url.hash) {
    throw new GovernanceInvalid('Target URL must name a REZICS resource');
  }
  const id = /^\/(?:v1\/)?(?:resources|works|agents|realms|media\/assets|posts|replies)\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (id) return ID + id[1];
  const segment = /^\/(?:w|work)\/([^/]+)$/.exec(url.pathname);
  if (!segment) throw new GovernanceInvalid('Unsupported REZICS target URL');
  const address = await deps.environment.addresses?.identify('work',decodeURIComponent(segment[1]!));
  if (!address?.holder || address.alias?.state === 'retired') throw new GovernanceDenied('Target is unavailable');
  // Reporting's reader and evidence owners admit private Works below. URL
  // identification must not impose the public resolver's anonymous disclosure.
  const resolution = await readMergedIdentity(deps.environment,address.holder,async () => true);
  return resolution?.survivor ?? address.holder;
}

/** One bounded Content batch and one graph batch supplement G-506's summary
 * owner. Reporting accepts every admitted base and does not require a type. */
function reportOwnerTargets(content: Pool): ReportTargets {
  return async (session, resources) => {
    const targets = new Map<string, ResolvedTarget>();
    const media = (await content.query<{ id: string; draft_head: string }>(`SELECT a.id::text, v.draft_head::text
      FROM media.asset a JOIN media.asset_state s ON s.id = a.state_head
      JOIN content.variant v ON v.id = a.variant_id
      JOIN content.revision r ON r.id = v.draft_head WHERE a.id = ANY($1::uuid[])
      AND s.disclosure = 'public' AND s.lifecycle = 'active' AND r.availability = 'available'`,
    [resources.map(resource => resource.slice(-36))])).rows;
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
    const replies = await session.query(`SELECT ?r ?contentRevision ?realm WHERE {
      VALUES ?r { ${resources.map(iri).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?slot a rv:RealmReplySlot ; rv:reply ?r ;
        rv:realm ?realm ; rv:replyPlacementHead ?placement .
        ?realm rv:realmState rv:Active ; rv:space ?space . ?space rv:disclosure rv:Public . }
      GRAPH ${iri(GRAPHS.revisions)} { ?placement rv:reply ?r ; rv:contentRevision ?contentRevision ;
        rv:rootTarget ?root ; rv:rootRevision ?rootRevision ; rv:placementOutcome rv:Accepted . }
      ${publicWork('?root', '?main')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?rootRevision a rv:ErasedRevision } }
    } ORDER BY ?r ?realm LIMIT ${resources.length * 16 + 1}`, resources.length * 16);
    for (const row of replies) {
      if (!row.r || !row.contentRevision?.value.startsWith('urn:rezics:content:revision:')) {
        throw new GovernanceUnavailable('Reply report target is invalid');
      }
      if (targets.has(row.r.value)) continue;
      const revision = row.contentRevision.value.slice('urn:rezics:content:revision:'.length);
      targets.set(row.r.value, { resource: row.r.value, revision: ID + revision, base: 'resource',
        types: ['https://rezics.com/vocab/MemberReply'], work: null, disclosure: 'public' });
    }
    return targets;
  };
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
  const capture = ownerEvidenceCapture({ graph: { env: deps.environment, canReadWork: async () => false },
    content: { core, canRead: async () => new Set() } });
  return {
    async resolve(input, request, principal) {
      const resource = await reportAddress(deps, input.target);
      const headers = new Headers(request.headers);
      // Invalid/suspended assertions and optional sign-in must never close intake.
      // Only an explicitly represented reader uses a private target read.
      if (!principal || !input.actingSubject) headers.delete('authorization');
      const reading = new Request(request.url, { method: 'POST', headers });
      const resolve = async (session: WorkReadSession) => {
          const [target] = await resolveTargets(session, [resource], 'report', undefined, reportOwnerTargets(contentPool));
          if (!target) throw new GovernanceDenied('Target is unavailable');
          const contentOwned = target.types.some(type => ['https://rezics.com/vocab/MediaAsset',
            'https://rezics.com/vocab/MemberReply'].includes(type));
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
        if (!(error instanceof AccountAssertionDenied)) throw error;
        headers.delete('authorization');
        return workRead(deps, new Request(request.url, { method: 'POST', headers }), {}, resolve);
      }
    },
  };
}
