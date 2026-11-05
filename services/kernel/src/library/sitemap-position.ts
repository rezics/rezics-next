import { ProblemError } from '../http/problem.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SitemapAfter } from './sitemap-discovery.ts';

/** An exhausted marker retains the epoch of the partition actually observed, including on an empty page. */
export type SitemapPosition = {
  partition: number;
  epoch: number;
} & ({ exhausted: true; after: null } | { exhausted: false; after: SitemapAfter });

const binding = (limit: number): ListCursorBinding => ({
  route: 'GET /v1/sitemap/collections',
  viewer: null,
  query: { limit },
});

export async function decodeSitemapPosition(
  tokens: KeyRing,
  limit: number,
  token: string | undefined,
  now: Date,
): Promise<SitemapPosition | null> {
  if (token === undefined) return null;
  const decoded = await decodeListCursor(tokens, binding(limit), token, now);
  if (!decoded.ok) throw new ProblemError('invalid_cursor');
  const [tag, partition, phase, route, id] = decoded.after;
  if (
    tag !== 'collections' ||
    typeof partition !== 'number' ||
    !Number.isSafeInteger(partition) ||
    partition < 0 ||
    partition >= PARTITIONS
  )
    throw new ProblemError('invalid_cursor');
  if (phase === 'done' && decoded.after.length === 3)
    return { partition, epoch: decoded.epoch, exhausted: true, after: null };
  if (
    phase !== 'scan' ||
    decoded.after.length !== 5 ||
    typeof route !== 'number' ||
    !Number.isSafeInteger(route) ||
    route < 0 ||
    route > 65535 ||
    partitionOf(route) !== partition ||
    typeof id !== 'string' ||
    routeOf(id) !== route
  )
    throw new ProblemError('invalid_cursor');
  return { partition, epoch: decoded.epoch, exhausted: false, after: { route, id } };
}

export function encodeSitemapPosition(tokens: KeyRing, limit: number, position: SitemapPosition, now: Date) {
  return encodeListCursor(
    tokens,
    binding(limit),
    {
      epoch: position.epoch,
      after: position.exhausted
        ? ['collections', position.partition, 'done']
        : ['collections', position.partition, 'scan', position.after.route, position.after.id],
    },
    now,
  );
}
