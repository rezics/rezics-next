import { DATASET, GRAPHS, RV, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { ResourceListing, RealmAdmission, RealmHistory } from './policy.ts';

export interface VisibilityReader {
  realmReadProof?: (realm: string) => Promise<string | null>;
  agentListing?: (agent: string) => Promise<ResourceListing>;
  agentReadable?: (agent: string) => Promise<boolean>;
  zoneReadable?: (zone: string) => Promise<boolean>;
}
export const VISIBILITY_COST = { graphReads: 2, rows: 2, bytes: 8192, accessPointReads: 2 } as const;
export function pageDiscoveryPolicy(visibility: 'public' | 'private', listing: ResourceListing) {
  const indexable = visibility === 'public' && listing === 'listed';
  return { indexable, robots: indexable ? 'index' as const : 'noindex' as const,
    referrerPolicy: listing === 'unlisted' ? 'no-referrer' as const : null };
}
export function pageDiscoveryHeaders(policy: ReturnType<typeof pageDiscoveryPolicy>) {
  return { ...(policy.indexable ? {} : { 'x-robots-tag': 'noindex' }),
    ...(policy.referrerPolicy ? { 'referrer-policy': policy.referrerPolicy } : {}) };
}

/** Shared, live read/find predicate for Space/capability identities and Agents.
 * Link readability never grants membership. Callers keep their existing content,
 * age, moderation and principal gates; this only narrows those admissions.
 * Inventory owners should select listed graph candidates before bounded paging,
 * then use this predicate as the final live fence, not filter an arbitrary page.
 * Directory/join/history are independent as in Matrix 1.1 (2026-10-02):
 * https://spec.matrix.org/v1.1/client-server-api/#room-history-visibility */
export async function readResourceVisibility(env: WorkActivationEnvironment, target: string,
  reader: VisibilityReader = {}) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT
    ?kind ?space ?realm ?disclosure ?zoneDisclosure ?listing ?history ?admission WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} . }
    GRAPH ${iri(GRAPHS.current)} {
      { ${iri(target)} a rv:Space . BIND(${iri(target)} AS ?space) BIND("space" AS ?kind) }
      UNION { ${iri(target)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space . BIND("space" AS ?kind) }
      UNION { ${iri(target)} a rv:Zone ; rv:zoneState rv:Active ; rv:space ?space ; rv:disclosure ?zoneDisclosure . BIND("space" AS ?kind) }
      UNION { ${iri(target)} a rv:Agent . BIND("agent" AS ?kind)
        OPTIONAL { ${iri(target)} rv:profileDisclosure ?disclosure }
        FILTER NOT EXISTS { ${iri(target)} a rv:AgentTombstone }
        FILTER NOT EXISTS { ${iri(target)} rv:protectionHead ?protection } }
      OPTIONAL { FILTER(?kind = "space") ?space a rv:Space ; rv:disclosure ?disclosure .
        OPTIONAL { ?space rv:listing ?listing }
        OPTIONAL { ?space rv:realmCapability ?realm . ?realm rv:realmState rv:Active .
          OPTIONAL { ?realm rv:historyVisibility ?history }
          OPTIONAL { ?realm rv:admissionMode ?admission } } }
    }
  } LIMIT 2`, VISIBILITY_COST.bytes)).results?.bindings ?? [];
  if (!rows.length) return null;
  if (rows.length !== 1) throw new Error('Resource visibility is ambiguous');
  return visibilityFromRow(rows[0]!, target, reader);
}

/** Exact home-Zone inventory: one graph statement for up to 256 identities.
 * Policy interpretation is shared with point reads, including Realm authority. */
export async function readZoneVisibilities(env: WorkActivationEnvironment, targets: readonly string[],
  reader: VisibilityReader = {}) {
  const requested = new Set(targets);
  if (targets.length > 256 || requested.size !== targets.length
    || targets.some(target => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target))) {
    throw new Error('Zone visibility inventory is invalid');
  }
  const visible = new Map<string, Awaited<ReturnType<typeof visibilityFromRow>>>();
  if (!targets.length) return visible;
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT DISTINCT
    ?target ?kind ?space ?realm ?disclosure ?zoneDisclosure ?listing ?history ?admission WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
      rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
      FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
    GRAPH ${iri(GRAPHS.current)} {
      ?target a rv:Zone ; rv:zoneState rv:Active ; rv:space ?space ; rv:disclosure ?zoneDisclosure .
      ?space a rv:Space ; rv:disclosure ?disclosure . BIND("space" AS ?kind)
      OPTIONAL { ?space rv:listing ?listing }
      OPTIONAL { ?space rv:realmCapability ?realm . ?realm rv:realmState rv:Active .
        OPTIONAL { ?realm rv:historyVisibility ?history }
        OPTIONAL { ?realm rv:admissionMode ?admission } }
    }
  } LIMIT ${targets.length + 1}`, 262_144)).results?.bindings ?? [];
  if (rows.length > targets.length || rows.some(row => !row.target || !requested.has(row.target.value))
    || new Set(rows.map(row => row.target!.value)).size !== rows.length) {
    throw new Error('Zone visibility inventory is ambiguous');
  }
  for (const row of rows) visible.set(row.target!.value, await visibilityFromRow(row, row.target!.value, reader));
  return visible;
}

async function visibilityFromRow(row: Record<string, { value: string } | undefined>, target: string,
  reader: VisibilityReader) {
  const agent = row.kind?.value === 'agent';
  if (!agent && (!row.space || !row.disclosure)) throw new Error('Space visibility is incomplete');
  const disclosure = row.disclosure?.value ?? `${RV}Public`;
  if (![`${RV}Public`, `${RV}Private`].includes(disclosure) || row.zoneDisclosure
    && ![`${RV}Public`,`${RV}Private`].includes(row.zoneDisclosure.value)) throw new Error('Resource disclosure is invalid');
  const visibility = disclosure === `${RV}Public` ? 'public' as const : 'private' as const;
  // Agent listing is Access-owned; absent adapter must never invent indexability.
  const listing = agent ? await reader.agentListing?.(target) ?? 'unlisted'
    : row.listing?.value ?? 'listed';
  const history = row.history?.value ?? 'everything', admission = row.admission?.value ?? 'invitation';
  if (!['listed','unlisted'].includes(listing) || !['everything','from-admission'].includes(history)
    || !['open','request','invitation'].includes(admission)) throw new Error('Resource visibility policy is invalid');
  // A Zone-only Space has no Realm membership to prove. Its own Access read
  // authority guards both private identities; a Space with a Realm keeps the
  // independent membership fence before any Zone grant can matter.
  const membershipReadable = disclosure === `${RV}Public`
    || !!(row.realm && await reader.realmReadProof?.(row.realm.value));
  // A Zone-only private Space has no Realm to prove. The Zone node's stored
  // disclosure is not another admission; Zone read authority is that Space's.
  const zoneOnlyPrivate = !row.realm && !!row.zoneDisclosure && disclosure === `${RV}Private`;
  const zoneAuthority = zoneOnlyPrivate && await reader.zoneReadable?.(target) === true;
  const spaceReadable = membershipReadable || zoneAuthority;
  const readable = agent ? visibility === 'public' && (await reader.agentReadable?.(target) ?? true)
    : spaceReadable;
  const discovery = pageDiscoveryPolicy(visibility, listing as ResourceListing);
  return { readable, findable: readable && discovery.indexable, visibility,
    listing: listing as ResourceListing, history: history as RealmHistory, admission: admission as RealmAdmission,
    space: row.space?.value ?? null, realm: row.realm?.value ?? null, discovery };
}
