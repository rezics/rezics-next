import { t } from 'elysia';
import { pageFields, readAvatar, readId, readName } from '../work/read-contract.ts';

export const realmDirectoryItem = t.Object({ id: readId, space: readId, name: readName,
  handle: t.Nullable(t.String({ pattern: '^[a-z][a-z0-9-]{2,29}$' })),
  reviewMode: t.Union([t.Literal('mandatory'), t.Literal('trusted-members'), t.Literal('open')]),
  icon: readAvatar, description: t.Nullable(readName),
  membership: t.Object({ count: t.Union([
    t.Object({ kind: t.Literal('unknown'), value: t.Null() }),
    t.Object({ kind: t.Literal('exact'), value: t.Integer({ minimum: 0 }), revision: t.String() }),
    t.Object({ kind: t.Literal('estimated'), value: t.Integer({ minimum: 0 }) }),
  ]) }),
  links: t.Object({ realm: t.String() }) });

export const realmDirectoryPage = t.Object({ profile: t.Literal('realm-directory-v1'),
  topic: t.Nullable(t.Object({ id: readId, label: readName })),
  items: t.Array(realmDirectoryItem, { maxItems: 20 }), ...pageFields });

/** Before the first publish, the route's existing 503 availability response
 * carries Retry-After; an empty exact page would imply a completed projection.
 * A cold GET only nudges the scheduler. Published pages may lag new writes and
 * carry their published sourcePosition; they never rebuild in the request.
 * Pages: one indexed SQL keyset query and one page of live summaries, no refresh.
 * Incremental refresh copies receipt-affected rows since the spare slot's last
 * publish, then hydrates this cycle's changes: O(changed), not O(Realms).
 * Each tick copies/clears at most 64 rows; restore/erasure rebuilds and mirrors
 * both generations in bounded batches while the published slot stays readable.
 * Substring search can scan the SQL index relation.
 * No candidate population ceiling; response and source batch sizes are separate. */
export const REALM_DIRECTORY_COST = { pageSize: 20, sourceBatch: 32,
  profileBatch: 4, refreshBatches: 2, graphCalls: 163, deadlineMs: 10_000,
  refreshIntervalMs: 1000, retryAfterSeconds: 1 } as const;
