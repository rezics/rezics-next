import { t } from 'elysia';
import { pageFields, readAvatar, readId, readName } from '../work/read-contract.ts';

export const realmDirectoryItem = t.Object({ id: readId, space: readId, name: readName,
  icon: readAvatar, description: t.Nullable(readName),
  membership: t.Object({ count: t.Union([
    t.Object({ kind: t.Literal('unknown'), value: t.Null() }),
    t.Object({ kind: t.Literal('estimated'), value: t.Integer({ minimum: 0 }) }),
  ]) }),
  links: t.Object({ realm: t.String() }) });

export const realmDirectoryPage = t.Object({ profile: t.Literal('realm-directory-v1'),
  items: t.Array(realmDirectoryItem, { maxItems: 20 }), ...pageFields });

/** Exact published profile values only: G-249 currently publishes estimated or unknown counts.
 * Sorts scan at most 128 public Realms and their public activity, then hydrate one page.
 * Above that ceiling the operation fails with 422 instead of silently returning a partial directory.
 * One bounded relation, up to 11 profile batches, one activity aggregate, two summary batches,
 * one lineage read and two position fences fit the shared Work read envelope.
 * Activity means creation, public profile publication or a current public Work adoption.
 * Graph work is O(R + A + R log R), where R <= 128 public Realms and A is their
 * current public adoption relation; an index is needed beyond this limit. */
export const REALM_DIRECTORY_COST = { pageSize: 20, candidateRows: 128, profileRows: 128,
  profileBatch: 12, activityRows: 128, graphCalls: 160, deadlineMs: 10_000 } as const;
