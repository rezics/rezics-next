import type { PoolClient } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import readAvatar from './read-avatar-media.sql';
import readSummaries from './read-avatar-summaries.sql';

export type AvatarSummary = Readonly<{
  media: string;
  width: number;
  height: number;
  placeholder: Readonly<{ thumbhash: string; color: string }>;
  variants: readonly Readonly<{ format: 'avif' | 'webp'; width: number }>[];
  focalPoint: Readonly<{ x: number; y: number }> | null;
  credit: null;
}>;

/** Access calls this fact read on the account's transaction when setting its avatar. */
export async function checkAvatarMedia(
  client: Pick<PoolClient, 'query'>,
  mediaId: string,
  accountId: string,
): Promise<boolean> {
  const route = routeOf(accountId);
  if (route === null || routeOf(mediaId) !== route) return false;
  return (await readAvatar.run(client, { route, media_id: mediaId, account_id: accountId })) !== null;
}

/** One statement per media partition; unavailable or malformed identities remain null. */
export async function readAvatarSummaries(
  client: Pick<PoolClient, 'query'>,
  ids: readonly string[],
): Promise<Map<string, AvatarSummary | null>> {
  if (ids.length < 1 || ids.length > 256) throw new RangeError('Avatar batches must contain 1 to 256 ids');
  const results = new Map<string, AvatarSummary | null>();
  const groups = new Map<number, { routes: number[]; mediaIds: string[] }>();
  for (const id of new Set(ids)) {
    results.set(id, null);
    const route = routeOf(id);
    if (route === null) continue;
    const partition = partitionOf(route);
    let group = groups.get(partition);
    if (!group) {
      group = { routes: [], mediaIds: [] };
      groups.set(partition, group);
    }
    group.routes.push(route);
    group.mediaIds.push(id);
  }
  for (const [partition, { routes, mediaIds }] of groups) {
    const rows = await readSummaries.run(client, { partition, routes, media_ids: mediaIds });
    for (const row of rows) results.set(row.mediaId, summary(row));
  }
  return results;
}

function summary(row: Awaited<ReturnType<typeof readSummaries.run>>[number]): AvatarSummary | null {
  if (
    row.width === null ||
    row.width < 1 ||
    row.height === null ||
    row.height < 1 ||
    row.thumbhash === null ||
    row.color === null ||
    !/^#[0-9a-f]{6}$/.test(row.color)
  )
    return null;
  const variants: unknown = JSON.parse(row.variantsJson);
  if (
    !Array.isArray(variants) ||
    variants.length > 12 ||
    variants.some(
      (variant) =>
        typeof variant !== 'object' ||
        variant === null ||
        (variant.format !== 'avif' && variant.format !== 'webp') ||
        !Number.isInteger(variant.width) ||
        variant.width < 1,
    )
  )
    return null;
  return {
    media: row.mediaId,
    width: row.width,
    height: row.height,
    placeholder: { thumbhash: row.thumbhash, color: row.color },
    variants,
    focalPoint: row.focalX === null || row.focalY === null ? null : { x: row.focalX, y: row.focalY },
    credit: null,
  };
}
