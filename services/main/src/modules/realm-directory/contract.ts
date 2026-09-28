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

/** Warm pages: one indexed SQL keyset query and one page of summaries.
 * Incremental refresh processes only affected Realms; restore/erasure rebuilds
 * in bounded source batches. Substring search can scan the SQL index relation.
 * No candidate population ceiling; response and source batch sizes are separate. */
export const REALM_DIRECTORY_COST = { pageSize: 20, sourceBatch: 32,
  profileBatch: 4, refreshBatches: 2, graphCalls: 163, deadlineMs: 10_000 } as const;
