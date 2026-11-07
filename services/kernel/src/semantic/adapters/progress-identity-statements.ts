/** Semantic-owned definition and identity SQL descriptors for Library progress planning. */

import { memoizedValue } from '../../memoized.ts';
import { RELEASE_LIMITS } from '@rezics/definitions';
import type { SemanticProgressIdentityDeclaration } from '../contract/index.ts';
import releaseRead from '../definitions-read.sql';
import releaseExists from '../definitions-exists.sql';
import releaseActive from '../definitions-active.sql';
import mappingOwners from '../identity-epoch-read-owners.sql';
import mappingSources from '../identity-epoch-read-sources.sql';
import mappingPending from '../identity-epoch-read-pending.sql';
import mappingCurrent from '../identity-terminal-closure-current.sql';
import subjectReference from '../read-subject-reference.sql';
import itemTypes from '../read-item-types.sql';

type QueryText = Readonly<{ sql: string; params?: readonly string[] }>;

const uuid = 'ffffffff-ffff-8fff-bfff-ffffffffffff';
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function descriptor(
  query: QueryText,
  nativeRows: number,
  nativePoints: number,
  resultBytes: number,
  identityMetadataRows = 0,
) {
  return Object.freeze({
    sql: query.sql,
    ...(query.params ? { params: query.params } : {}),
    nativeRows,
    nativePoints,
    identityMetadataRows,
    resultBytes,
  });
}

/** Inclusive native maxima for one original Source mapping/definition/type leaf. */
export function semanticProgressIdentityStatements(): SemanticProgressIdentityDeclaration {
  return memoizedValue(semanticProgressIdentityStatements, () =>
    Object.freeze({
      'release-exists': descriptor(releaseExists, 1, 1, size({ digest: `sha256:${'f'.repeat(64)}` })),
      'release-read': descriptor(releaseRead, 1, 1, 6 * RELEASE_LIMITS.bytes),
      'release-active': descriptor(
        releaseActive,
        1,
        1,
        size({ digest: `sha256:${'f'.repeat(64)}`, head: 2_147_483_647 }),
      ),
      'mapping-owners': descriptor(mappingOwners, 1, 1, 256, 1),
      'mapping-sources': descriptor(mappingSources, 4, 4, 2048, 3),
      'mapping-pending': descriptor(mappingPending, 1, 1, 256, 1),
      'mapping-current': descriptor(mappingCurrent, 4, 4, 2048, 3),
      'subject-reference': descriptor(subjectReference, 2, 2, size({ id: uuid, redirect: uuid })),
      'item-types': descriptor(
        itemTypes,
        2,
        2,
        size({ id: uuid, type: '', agent_account_id: uuid, agent_verified: false }) + 6 * RELEASE_LIMITS.bytes,
      ),
    }),
  );
}
