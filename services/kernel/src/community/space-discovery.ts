import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { lookupEventType } from '../events/catalogue.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { SPACE_DISCOVERY_INVALIDATED, type SpaceDiscoveryInvalidation } from './space-discovery-events.ts';

const spaceTypes = [
  'created',
  'updated',
  'removed',
  'restored',
  'address-changed',
  'address-claim-accepted',
  'address-activated',
].map((name) => `com.rezics.community.space.${name}.v1`);
const realmTypes = ['created', 'updated', 'removed', 'restored', 'board-scheme'].map(
  (name) => `com.rezics.community.realm.${name}.v1`,
);
const mediaTypes = ['available', 'rejected', 'erased', 'collected', 'taken-down'].map(
  (name) => `com.rezics.content.media.${name}.v1`,
);
const contextTypes = ['com.rezics.semantic.record.deleted.v1', 'com.rezics.semantic.record.restored.v1'];
const fenceType = 'com.rezics.content.source_fence.taken_down.v1';
const exposureTypes = ['com.rezics.access.exposure.opened.v1', 'com.rezics.access.exposure.closed.v1'];
export const SPACE_DISCOVERY_NATIVE_EVENTS = [
  ...spaceTypes,
  ...realmTypes,
  ...mediaTypes,
  ...contextTypes,
  fenceType,
  ...exposureTypes,
];

const basis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-community',
  requestedBy: null,
};

/** Exact log identity, not a wall clock, event UUID ordering or a caller's eligibility flag. */
function origin(event: CloudEvent): SpaceDiscoveryInvalidation['origin'] {
  const match = /^urn:rezics:log:(\d+)\.(\d+)$/.exec(event.source);
  if (!match || !/^0*[1-9][0-9]*$/.test(event.sequence)) throw new TypeError('Invalid Space discovery log origin');
  const partition = Number(match[1]);
  const epoch = Number(match[2]);
  const position = BigInt(event.sequence);
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition > 4095 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    position > 9223372036854775807n
  )
    throw new TypeError('Invalid Space discovery log origin');
  return { partition, epoch, position: position.toString(), eventId: event.id, type: event.type };
}

/** Consumes committed native events only. The reader/bootstrap task owns population and hydration.
 * Removed identities must still resolve: an active-only Realm read would lose the removal delta.
 */
export async function spaceDiscoveryInvalidation(
  pool: Pool,
  event: CloudEvent,
): Promise<SpaceDiscoveryInvalidation | null> {
  if (!SPACE_DISCOVERY_NATIVE_EVENTS.includes(event.type)) return null;
  if (!lookupEventType(event.type)?.Check(event.data)) throw new TypeError('Invalid Space discovery native event');
  const data = event.data as Record<string, unknown>;
  const evidence = origin(event);
  let target: SpaceDiscoveryInvalidation['target'];
  const sameHome = (id: unknown): string => {
    const route = typeof id === 'string' ? routeOf(id) : null;
    if (route === null || partitionOf(route) !== evidence.partition || event.subject !== id)
      throw new TypeError('Invalid Space discovery native identity');
    return id as string;
  };
  if (spaceTypes.includes(event.type)) {
    target = { kind: 'space', id: sameHome(data.spaceId ?? data.id) };
  } else if (realmTypes.includes(event.type)) {
    const realmId = sameHome(data.realmId ?? data.id);
    const space = await withConnection(
      pool,
      async (client) =>
        (
          await client.query<{ space_id: string }>(
            'SELECT space_id FROM community.realm WHERE route=$1 AND realm_id=$2',
            [routeOf(realmId), realmId],
          )
        ).rows[0],
    );
    // Native Realm identities and their carrying slot are retained across removal.
    if (!space) throw new Error('Space discovery Realm binding unavailable');
    target = { kind: 'space', id: space.space_id };
  } else if (contextTypes.includes(event.type)) {
    if (data.kind !== 'context') return null;
    target = { kind: 'context', id: sameHome(data.id) };
  } else if (mediaTypes.includes(event.type)) {
    // Media events do not all carry a subject; their schema supplies the exact media identity.
    const mediaId = data.mediaId as string;
    const route = routeOf(mediaId);
    if (route === null || partitionOf(route) !== evidence.partition)
      throw new TypeError('Invalid Space discovery media identity');
    target = { kind: 'media', id: mediaId };
  } else if (event.type === fenceType) {
    const route = data.route as number;
    if (partitionOf(route) !== evidence.partition) throw new TypeError('Invalid Space discovery fence home');
    target = {
      kind: 'source-fence',
      route,
      source: data.source as string,
      externalId: data.external_id as string,
      fieldGroup: data.field_group as 'facts' | 'summary' | 'cover',
    };
  } else {
    if (!data.changed) return null;
    target = { kind: 'exposure', group: data.group as string };
  }
  return {
    target,
    origin: evidence,
    revisionId: (data.revisionId ?? data.headRevisionId ?? null) as string | null,
    nativeVersion: (data.version ?? data.securityRevision ?? null) as string | null,
  };
}

/** Generic effects retain the original event and retry after a crash. A command receipt coalesces
 * repeat delivery; after receipt retention, another invalidation is safe because consumers reread truth.
 * Dependency targets represent one durable scope obligation, never a census in a mutation/effect.
 */
export function createSpaceDiscoveryEffect(pool: Pool): Effect {
  return {
    name: 'community_space_discovery',
    types: SPACE_DISCOVERY_NATIVE_EVENTS,
    async run(event) {
      const invalidation = await spaceDiscoveryInvalidation(pool, event);
      if (!invalidation) return;
      const key = createHash('sha256').update(JSON.stringify(invalidation)).digest('hex');
      await runCommand(
        pool,
        {
          partition: invalidation.origin.partition,
          basis,
          receipt: {
            actorAccountId: basis.actorAccountId,
            kind: 'community.space-discovery.invalidate',
            key,
            digest: createHash('sha256').update(key).digest(),
          },
        },
        async () => ({
          value: null,
          events: [
            {
              type: SPACE_DISCOVERY_INVALIDATED,
              ...(invalidation.target.kind === 'space' ? { subject: invalidation.target.id } : {}),
              data: invalidation,
            },
          ],
        }),
      );
    },
  };
}
