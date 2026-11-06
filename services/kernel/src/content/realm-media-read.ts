import type { Pool } from 'pg';
import { createResourcePublicEligibility } from '../access/index.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, mintReadTime } from '../command/command.ts';
import { readRealm, realmReadEligibility } from '../community/realm.ts';
import realmHead from '../community/realm-read.sql';
import { readSpace, spaceReadEligibility } from '../community/space.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type AccessClient } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { ReadContext } from './model.ts';
import type { MediaVariant } from './media.ts';
import { mediaParentSnapshot } from './media-parent.ts';
import read from './realm-media-read.sql';
import readWork from './realm-media-read-work.sql';
import { mediaEligibilityCallbacks } from './media-eligibility-access-work.ts';

type Row = NonNullable<Awaited<ReturnType<typeof read.run>>>;
const signature = (value: unknown) => JSON.stringify(value);
const digest = /^[0-9a-f]{64}$/;

export function realmMediaVariants(row: Row): readonly MediaVariant[] {
  const variants: unknown = JSON.parse(row.variants_json);
  if (!Array.isArray(variants) || variants.length < 1 || variants.length > 12) return [];
  if (
    variants.some(
      (v) =>
        !v ||
        (v.format !== 'avif' && v.format !== 'webp') ||
        !Number.isSafeInteger(v.width) ||
        v.width < 1 ||
        !Number.isSafeInteger(v.height) ||
        v.height < 1 ||
        v.mediaType !== `image/${v.format}` ||
        !Number.isSafeInteger(v.byteCount) ||
        v.byteCount < 1 ||
        !digest.test(v.sha256) ||
        v.key !== `m/${row.media_id}/${v.format}-${v.width}`,
    )
  )
    return [];
  return variants;
}
function usable(row: Row, realmId: string): boolean {
  return (
    row.container_id === realmId &&
    row.claimed_realm_id === realmId &&
    row.claimed_at !== null &&
    (row.purpose === 'realm-icon' || row.purpose === 'realm-banner') &&
    row.state === 'available' &&
    !row.erased &&
    !row.taken_down &&
    !row.collection_pending &&
    row.sha256 !== null &&
    digest.test(row.sha256) &&
    realmMediaVariants(row).length > 0
  );
}

/** Internal transport facts, never a persisted permission or public image summary.
 * Source and final Realm/media anchors share their exact home. The host is independently anchored,
 * even when co-located, and every checkout is released before preparing another Access formula. */
export async function authorizedRealmMedia(
  deps: Readonly<{ pool: Pool; access: Access; deadlineNow?: () => number }>,
  realmId: string,
  mediaIds: readonly (string | null)[],
  context: ReadContext,
): Promise<ReadonlyMap<string, Row>> {
  if (mediaIds.length > 2) throw new RangeError('At most two Realm images');
  const rows = new Map<string, Row>();
  const route = routeOf(realmId);
  if (route === null || !Number.isFinite(context.deadline) || Date.now() >= context.deadline) return rows;
  const ids = [...new Set(mediaIds.filter((id): id is string => id !== null && routeOf(id) === route))];
  if (!ids.length) return rows;
  const snapshot = <T>(home: number, work: (client: AccessClient) => Promise<T>) =>
    mediaParentSnapshot(deps.pool, home, context.deadline, work);
  try {
    const initialRealm = await readRealm(deps, context.actor, realmId, context);
    if (!initialRealm) return rows;
    const hostRoute = routeOf(initialRealm.spaceId);
    if (hostRoute === null) return rows;
    const initialHost = await snapshot(hostRoute, async (client) =>
      readSpace(client, initialRealm.spaceId, authoritativeTimeValue(await mintReadTime(client))),
    );
    if (!initialHost) return rows;
    const accessContext = { pool: deps.pool, deadline: context.deadline };
    const realmResource = { route, id: realmId };
    const realm = await accessCheck(
      deps.access,
      context.actor,
      'realm:read',
      { ...realmResource, eligibility: realmReadEligibility(realmResource) },
      accessContext,
    );
    const hostResource = { route: hostRoute, id: initialRealm.spaceId };
    const host = await accessCheck(
      deps.access,
      context.actor,
      'space:read',
      { ...hostResource, eligibility: spaceReadEligibility(hostResource) },
      accessContext,
    );
    const initial = await snapshot(route, async (client) => {
      const result = new Map<string, Row>();
      for (const id of ids) {
        const row = await read.run(client, { route, media_id: id });
        if (row && usable(row, realmId)) result.set(id, row);
      }
      return result;
    });
    const checks = new Map<string, Awaited<ReturnType<typeof accessCheck>>>();
    for (const [id, row] of initial) {
      const resource = { route, id };
      checks.set(
        id,
        await accessCheck(
          deps.access,
          context.actor,
          'media:read',
          {
            ...resource,
            eligibility: createResourcePublicEligibility({
              resource,
              action: 'media:read',
              ...mediaEligibilityCallbacks({
                evidence: row,
                media: { kind: 'realm', route, id },
                async verify({ client }, reads) {
                  const current = await reads.media((bounded) =>
                    (bounded ? readWork : read).run(client, { route, media_id: id }),
                  );
                  if (!current || !usable(current, realmId) || signature(current) !== signature(row))
                    throw new GrantDeniedError();
                  // The available derivative has a media floor; the independent Realm gate is mandatory.
                  return true;
                },
              }),
            }),
          },
          accessContext,
        ),
      );
    }
    // Fixed final host anchor. No missing/removed host can become a Global resource.
    const hostCurrent = await snapshot(hostRoute, async (client) => {
      const time = await mintReadTime(client);
      const current = await readSpace(client, initialRealm.spaceId, authoritativeTimeValue(time));
      return current !== null && signature(current) === signature(initialHost) && (await host(client, time));
    });
    if (!hostCurrent) return rows;
    return await snapshot(route, async (client) => {
      const time = await mintReadTime(client);
      const current = await realmHead.run(client, { route, id: realmId, at: authoritativeTimeValue(time) });
      if (
        !current ||
        current.head_revision_id !== initialRealm.headRevisionId ||
        current.space_id !== initialRealm.spaceId ||
        current.context_id !== initialRealm.contextId ||
        current.visibility !== initialRealm.visibility ||
        !(await realm(client, time))
      )
        return rows;
      for (const [id, before] of initial) {
        const row = await read.run(client, { route, media_id: id });
        if (
          row &&
          usable(row, realmId) &&
          signature(row) === signature(before) &&
          (await checks.get(id)!(client, time))
        )
          rows.set(id, row);
      }
      if (Date.now() >= context.deadline) rows.clear();
      return rows;
    });
  } catch (error) {
    if (error instanceof GrantDeniedError || (error instanceof ProblemError && error.code === 'not_found')) return rows;
    throw error;
  }
}
