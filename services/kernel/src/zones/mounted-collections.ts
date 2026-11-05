import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { admitGroup } from '../access/gates/admission.ts';
import { ProblemError } from '../http/problem.ts';
import { collectionReadView, createCollectionReads, type CollectionResourceView } from '../library/collection-reads.ts';
import type { Access, Actor } from '../request/access.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createZoneReads, type ZoneCollectionBasis } from './resource-reads.ts';

const CURSOR_EPOCH = 1;
const CURSOR_ROUTE = 'GET /v1/zones/{id}/collections';

function publicCollectionView(value: CollectionResourceView) {
  const view = collectionReadView(value);
  if (!('allowedVisibilityActions' in view)) return view;
  const { allowedVisibilityActions: _ownerActions, ...publicView } = view;
  return publicView;
}

type PublicCollectionView = ReturnType<typeof publicCollectionView>;

export type ZoneCollectionPage = {
  collections: PublicCollectionView[];
  next: string | null;
};

export async function readZoneCollections(
  dependencies: { pool: Pool; access: Access; tokens: KeyRing; clock: () => Date },
  input: {
    actor: Actor;
    id: string;
    limit?: number;
    cursor?: string;
    deadline: number;
    clientAction: string;
  },
): Promise<ZoneCollectionPage> {
  const { pool, access, tokens, clock } = dependencies;
  const { actor, id, deadline } = input;
  const zones = createZoneReads(dependencies);
  const first = await zones.collectionBasis(actor, id, deadline);

  await admitGroup({
    pool,
    access: () => access,
    actor,
    group: 'zone_sources',
    clientAction: input.clientAction,
    deadline,
    clock,
  });

  const limit = input.limit ?? 20;
  const binding: ListCursorBinding = {
    route: CURSOR_ROUTE,
    viewer: actor.kind === 'account' ? actor.accountId : null,
    query: { zoneId: id, limit },
  };
  const cursor = input.cursor === undefined ? null : await decodeListCursor(tokens, binding, input.cursor, clock());
  if (cursor && !cursor.ok) throw new ProblemError('invalid_cursor');
  let after: string | null = null;
  if (cursor?.ok) {
    const [idAfter, revision, lifecycleRevision] = cursor.after;
    if (
      cursor.epoch !== CURSOR_EPOCH ||
      cursor.after.length !== 3 ||
      typeof idAfter !== 'string' ||
      typeof revision !== 'string' ||
      typeof lifecycleRevision !== 'string'
    )
      throw new ProblemError('invalid_cursor');
    if (revision !== first.revision || lifecycleRevision !== first.lifecycleRevision)
      throw new ProblemError('stale_cursor');
    after = idAfter;
  }

  const collections = createCollectionReads({ pool, access, tokens });
  const readVisible = async (mounts: readonly string[]) => {
    const visible: PublicCollectionView[] = [];
    for (const mount of mounts) {
      try {
        visible.push(publicCollectionView(await collections.readCollection(actor, mount, deadline)));
      } catch (error) {
        if (error instanceof ProblemError && error.code === 'not_found') continue;
        throw error;
      }
    }
    return visible;
  };

  const selected = await readVisible(first.mounts);
  const finalSources = await readVisible(first.mounts);
  const final = await zones.collectionBasis(actor, id, deadline);
  if (!sameBasis(first, final) || !isDeepStrictEqual(selected, finalSources))
    throw new ProblemError(cursor?.ok ? 'stale_cursor' : 'conflict');

  const start = after === null ? 0 : finalSources.findIndex((collection) => collection.id === after) + 1;
  if (after !== null && start === 0) throw new ProblemError('stale_cursor');
  const page = finalSources.slice(start, start + limit);
  const last = page.at(-1);
  const next =
    last && start + page.length < finalSources.length
      ? await encodeListCursor(
          tokens,
          binding,
          {
            epoch: CURSOR_EPOCH,
            after: [last.id, final.revision, final.lifecycleRevision],
          },
          clock(),
        )
      : null;
  return { collections: page, next };
}

function sameBasis(left: ZoneCollectionBasis, right: ZoneCollectionBasis): boolean {
  return (
    left.revision === right.revision &&
    left.lifecycleRevision === right.lifecycleRevision &&
    left.visibility === right.visibility &&
    left.ownerId === right.ownerId &&
    isDeepStrictEqual(left.mounts, right.mounts)
  );
}
