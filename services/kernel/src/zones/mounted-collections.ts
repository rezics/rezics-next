import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { admitGroup } from '../access/gates/admission.ts';
import { ProblemError } from '../http/problem-error.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { zoneCollectionReads, type ZoneCollectionPublicView } from './collection-port.ts';
import {
  decodeZoneCollectionsCursor,
  encodeZoneCollectionsCursor,
  zoneCollectionsCursorBinding,
} from './page-continuation.ts';
import { createZoneReads, type ZoneCollectionBasis } from './resource-reads.ts';

export type ZoneCollectionPage = {
  collections: ZoneCollectionPublicView[];
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
  const binding = zoneCollectionsCursorBinding(actor, id, limit);
  const cursor = await decodeZoneCollectionsCursor(tokens, binding, input.cursor, clock(), first);
  if (!cursor.ok) throw new ProblemError(cursor.reason === 'stale' ? 'stale_cursor' : 'invalid_cursor');
  const after = cursor.after;

  const collections = zoneCollectionReads({ pool, access, tokens });
  const readVisible = async (mounts: readonly string[]) => {
    const visible: ZoneCollectionPublicView[] = [];
    for (const mount of mounts) {
      try {
        visible.push(collections.projectPublic(await collections.readCollection(actor, mount, deadline)));
      } catch (error) {
        if (collections.isConcealed(error)) continue;
        throw error;
      }
    }
    return visible;
  };

  const selected = await readVisible(first.mounts);
  const finalSources = await readVisible(first.mounts);
  const final = await zones.collectionBasis(actor, id, deadline);
  if (!sameBasis(first, final) || !isDeepStrictEqual(selected, finalSources))
    throw new ProblemError(input.cursor !== undefined && cursor.ok ? 'stale_cursor' : 'conflict');

  const start = after === null ? 0 : finalSources.findIndex((collection) => collection.id === after) + 1;
  if (after !== null && start === 0) throw new ProblemError('stale_cursor');
  const page = finalSources.slice(start, start + limit);
  const last = page.at(-1);
  const next =
    last && start + page.length < finalSources.length
      ? await encodeZoneCollectionsCursor(
          tokens,
          binding,
          { id: last.id, revision: final.revision, lifecycleRevision: final.lifecycleRevision },
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
