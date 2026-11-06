import type { Pool } from 'pg';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { Access, ReadDecisions } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { realmViewerActionResource } from './realm.ts';
import { realmPresentation } from './presentation.ts';
import { spaceViewerActionResource } from './space.ts';
import { readRealmDiscoveryGate } from './discovery-source.ts';
import { discoveryDescription, type DiscoveryRealm } from './discovery.ts';
import {
  DISCOVERY_PARTITION,
  discoverySnapshot,
  stateColumns,
  type DiscoveryBudget,
  type DiscoveryState,
} from './discovery-projection-store.ts';

export type DiscoveryCandidate = DiscoveryState & { count: string };
type Head = {
  realm_id: string;
  space_id: string;
  visibility: string;
  state: string;
  head_revision_id: string;
  context_id: string;
  created_at: string;
};
type Revision = {
  realm_id: string;
  revision_id: string;
  title: string;
  summary: string;
  presentation: unknown;
  created_at: string;
};
export type DiscoveryCard = {
  value: DiscoveryRealm;
  avatarMediaId: string | null;
  binding: string;
};
type Space = { space_id: string; state: string; head_revision_id: string; created_at: string };

export async function prepareDiscoveryAccess(pool: Pool, access: Access, deadline: number): Promise<ReadDecisions> {
  if (!access.prepareReadDecisions) throw new AccessUnavailableError('overloaded');
  return access.prepareReadDecisions({
    actor: { kind: 'anonymous' },
    actions: new Set(['realm:read', 'space:read']),
    context: { pool, deadline },
  });
}

/** Reusable first/final check: native batched owner eligibility and current source gates in released home snapshots. */
export async function readDiscoveryCards(
  pool: Pool,
  decisions: ReadDecisions,
  candidates: readonly DiscoveryCandidate[],
  cutoff: string,
  at: string,
  budget: DiscoveryBudget,
): Promise<Map<string, DiscoveryCard>> {
  const groups = new Map<number, DiscoveryCandidate[]>();
  for (const candidate of candidates) {
    const route = routeOf(candidate.realm_id);
    if (route === null) throw new TypeError('Malformed discovery rank identity');
    const partition = partitionOf(route);
    const group = groups.get(partition) ?? [];
    group.push(candidate);
    groups.set(partition, group);
  }
  const cards = new Map<string, DiscoveryCard>();
  for (const [partition, group] of groups) {
    const visible = await discoverySnapshot(pool, partition, budget, async (client) => {
      const ids = group.map((c) => c.realm_id);
      const routes = ids.map((id) => routeOf(id)!);
      const heads = (
        await client.query<Head>(
          `SELECT realm_id,space_id,visibility,state,head_revision_id,context_id,created_at::text
        FROM community.realm WHERE (route,realm_id) IN (SELECT * FROM unnest($1::integer[],$2::uuid[]))`,
          [routes, ids],
        )
      ).rows;
      const realms = await decisions.decide(client, {
        action: 'realm:read',
        resourceType: 'community.realm',
        ids,
        eligibility: async (connection, keys, time) => ({
          ...Object.fromEntries(keys.map((id) => [id, false])),
          ...(await realmViewerActionResource.read(connection, keys, time)),
        }),
      });
      const revisions = (
        await client.query<Revision>(
          `SELECT realm_id,revision_id,title,summary,presentation,created_at::text
        FROM community.realm_revision WHERE (route,realm_id,revision_id) IN
        (SELECT * FROM unnest($1::integer[],$2::uuid[],$3::uuid[]))`,
          [heads.map((h) => routeOf(h.realm_id)!), heads.map((h) => h.realm_id), heads.map((h) => h.head_revision_id)],
        )
      ).rows;
      const spaceIds = [...new Set(heads.map((h) => h.space_id))];
      if (spaceIds.some((id) => routeOf(id) === null || partitionOf(routeOf(id)!) !== partition))
        throw new TypeError('Malformed Realm host identity');
      const spaceRoutes = spaceIds.map((id) => routeOf(id)!);
      const spaces = (
        await client.query<Space>(
          `SELECT space_id,state,head_revision_id,created_at::text
        FROM community.space WHERE (route,space_id) IN (SELECT * FROM unnest($1::integer[],$2::uuid[]))`,
          [spaceRoutes, spaceIds],
        )
      ).rows;
      const spaceRevisions = (
        await client.query<{ revision_id: string; created_at: string }>(
          `SELECT revision_id,created_at::text
        FROM community.space_revision WHERE (route,space_id,revision_id) IN
        (SELECT * FROM unnest($1::integer[],$2::uuid[],$3::uuid[]))`,
          [
            spaces.map((s) => routeOf(s.space_id)!),
            spaces.map((s) => s.space_id),
            spaces.map((s) => s.head_revision_id),
          ],
        )
      ).rows;
      const slots = (
        await client.query<{ realm_id: string; space_id: string }>(
          `SELECT realm_id,space_id
        FROM community.realm WHERE (route,space_id) IN (SELECT * FROM unnest($1::integer[],$2::uuid[]))`,
          [spaceRoutes, spaceIds],
        )
      ).rows;
      const allowedSpaces = spaceIds.length
        ? await decisions.decide(client, {
            action: 'space:read',
            resourceType: 'community.space',
            ids: spaceIds,
            eligibility: async (connection, keys, time) => ({
              ...Object.fromEntries(keys.map((id) => [id, false])),
              ...(await spaceViewerActionResource.read(connection, keys, time)),
            }),
          })
        : {};
      const result: DiscoveryCard[] = [];
      for (const candidate of group) {
        const head = heads.find((h) => h.realm_id === candidate.realm_id);
        const revision = revisions.find(
          (r) => r.realm_id === candidate.realm_id && r.revision_id === head?.head_revision_id,
        );
        const space = spaces.find((s) => s.space_id === head?.space_id);
        const spaceRevision = spaceRevisions.find((s) => s.revision_id === space?.head_revision_id);
        const gate = await readRealmDiscoveryGate(client, candidate.realm_id);
        if (
          !gate ||
          !gate.settled ||
          !candidate.settled ||
          candidate.realm_epoch !== gate.realm_epoch ||
          candidate.applied_generation !== gate.generation ||
          candidate.cutoff !== cutoff ||
          !head ||
          head.state !== 'active' ||
          head.visibility !== 'public' ||
          !realms[head.realm_id]?.allowed ||
          !revision ||
          !space ||
          space.state !== 'active' ||
          !allowedSpaces[space.space_id]?.allowed ||
          !spaceRevision ||
          !slots.some((s) => s.space_id === space.space_id && s.realm_id === head.realm_id) ||
          [head.created_at, revision.created_at, space.created_at, spaceRevision.created_at].some(
            (t) => Date.parse(t) > Date.parse(at),
          )
        )
          continue;
        const presentation = realmPresentation(revision.presentation);
        result.push({
          value: {
            realmId: head.realm_id,
            spaceId: space.space_id,
            name: revision.title,
            description: discoveryDescription(revision.summary),
            avatar: null,
          },
          avatarMediaId: presentation.avatarMediaId,
          binding: JSON.stringify([
            head.head_revision_id,
            head.space_id,
            head.context_id,
            space.head_revision_id,
            presentation,
          ]),
        });
      }
      return result;
    });
    for (const card of visible) cards.set(card.value.realmId, card);
  }
  return cards;
}

/** Exact aggregate keys only; expiry and native source changes can invalidate a candidate between snapshots. */
export async function currentDiscoveryCandidates(
  pool: Pool,
  candidates: readonly DiscoveryCandidate[],
  budget: DiscoveryBudget,
): Promise<DiscoveryCandidate[]> {
  if (!candidates.length) return [];
  return discoverySnapshot(pool, DISCOVERY_PARTITION, budget, async (client) => {
    const rows = (
      await client.query<DiscoveryState>(
        `SELECT ${stateColumns} FROM community.discovery_realm
      WHERE route=0 AND realm_id=ANY($1::uuid[])`,
        [candidates.map((c) => c.realm_id)],
      )
    ).rows;
    return candidates.filter((candidate) =>
      rows.some(
        (row) =>
          row.realm_id === candidate.realm_id &&
          row.realm_epoch === candidate.realm_epoch &&
          row.applied_generation === candidate.applied_generation &&
          row.settled &&
          row.cutoff === candidate.cutoff &&
          row.popular === candidate.popular &&
          row.trending === candidate.trending,
      ),
    );
  });
}
