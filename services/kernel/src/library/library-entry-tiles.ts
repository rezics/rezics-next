import { t } from 'elysia';
import type { PoolClient } from 'pg';
import type { Static } from 'typebox';
import { libraryStoredVocabularySchema } from './profile-schemas.ts';
import { createShelfActiveReader } from './shelf-active.ts';
import { shelfSessionSchema } from './shelf-schemas.ts';
import entryTiles from './library-entry-tiles.sql';

const uuid = t.String({ format: 'uuid' });
const nullableText = t.Union([t.String(), t.Null()]);
export const libraryEntryTileSchema = t.Object(
  {
    subjectId: uuid,
    state: libraryStoredVocabularySchema,
    revision: t.Integer({ minimum: 1, maximum: 2_147_483_646 }),
    createdAt: t.String(),
    updatedAt: t.String(),
    incarnationId: t.Union([uuid, t.Null()]),
    lastActivityAt: t.String(),
    finishedAt: nullableText,
    activeProgressSession: t.Union([shelfSessionSchema, t.Null()]),
  },
  { additionalProperties: false },
);
export type LibraryEntryTile = Static<typeof libraryEntryTileSchema>;

/** Requires the caller's already-admitted read-only owner RR snapshot. Grants no authority. */
export async function readLibraryEntryTiles(
  client: Pick<PoolClient, 'query'>,
  input: { route: number; accountId: string; subjectIds: readonly string[] },
): Promise<Map<string, LibraryEntryTile>> {
  // Bound raw input before iteration: duplicate keys do not buy unbounded validation work.
  if (input.subjectIds.length > 100) throw new RangeError('An entry tile batch accepts at most 100 subjects');
  const distinct = new Set<string>();
  for (const id of input.subjectIds) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new TypeError('An entry tile subject must be a UUID');
    distinct.add(id);
  }
  const result = new Map<string, LibraryEntryTile>();
  if (distinct.size === 0) return result;
  const entries = await entryTiles.run(
    { query: client.query.bind(client) },
    { route: input.route, account_id: input.accountId, subject_ids: [...distinct] },
  );
  if (entries.length === 0) return result;
  const sessions = await createShelfActiveReader().sessions(
    client,
    input.route,
    input.accountId,
    entries.map((entry) => entry.subjectId),
  );
  for (const entry of entries) {
    if (entry.createdAt === null || entry.updatedAt === null || entry.lastActivityAt === null)
      throw new Error('Library entry timestamps are required');
    const active = sessions.get(entry.subjectId);
    if (active?.state === 'retired') throw new Error('Retired sessions cannot appear on the Library shelf');
    result.set(entry.subjectId, {
      ...entry,
      createdAt: new Date(entry.createdAt).toISOString(),
      updatedAt: new Date(entry.updatedAt).toISOString(),
      lastActivityAt: new Date(entry.lastActivityAt).toISOString(),
      finishedAt: entry.finishedAt === null ? null : new Date(entry.finishedAt).toISOString(),
      activeProgressSession: active ? { ...active, state: active.state } : null,
    });
  }
  return result;
}
