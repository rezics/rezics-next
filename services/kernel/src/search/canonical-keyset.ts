import type { Pool } from 'pg';
import { readIdentityBasis } from '../semantic/identity-basis.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import {
  admitCanonicalKeyset,
  type CanonicalKeysetAdmission,
  type SearchIdentityMapping,
} from './canonical-keyset-admit.ts';

export {
  admitCanonicalKeyset,
  bindSearchIdentityCursorRequest,
  type CanonicalHitKey,
  type CanonicalKeysetAdmission,
  type SearchIdentityMapping,
} from './canonical-keyset-admit.ts';

/** Published identity meaning bound into every confidential Search continuation. */
export type SearchIdentityEpoch = Readonly<{ status: 'ready'; digest: string }> | Readonly<{ status: 'preparing' }>;

const MAPPING_PAGE = 100;

/** One digest for the current published identity meaning, or readiness while an epoch is pending. */
export async function observeSearchIdentityEpoch(pool: Pool, deadline: number): Promise<SearchIdentityEpoch> {
  const observed = await readIdentityBasis(pool, { deadline });
  return observed.state === 'ready' ? { status: 'ready', digest: observed.basis.digest } : { status: 'preparing' };
}

function searchIdentityMapping(
  mapping: Awaited<ReturnType<typeof readIdentityMappings>>[number],
): SearchIdentityMapping {
  if (mapping.state === 'mapped') return { state: 'mapped', original: mapping.original, terminal: mapping.terminal };
  if (mapping.state === 'pending') return { state: 'pending', original: mapping.original };
  if (mapping.state === 'absent') return { state: 'absent' };
  return { state: 'unavailable', reason: mapping.reason };
}

export async function readSearchIdentityMappings(
  pool: Pool,
  originals: readonly string[],
): Promise<readonly SearchIdentityMapping[]> {
  if (!originals.length) return [];
  const mappings: SearchIdentityMapping[] = [];
  for (let offset = 0; offset < originals.length; offset += MAPPING_PAGE)
    mappings.push(
      ...(await readIdentityMappings(pool, originals.slice(offset, offset + MAPPING_PAGE))).map(searchIdentityMapping),
    );
  return mappings;
}

/** Resolve maintained identity paths for the disclosed page, then admit unique terminals. */
export async function resolveCanonicalKeyset<T extends { id: string }>(
  pool: Pool,
  subjects: readonly T[],
): Promise<CanonicalKeysetAdmission<T>> {
  if (!subjects.length)
    return {
      status: 'ready',
      accepted: new Map(),
      keys: new Map(),
      canonicalId: (value) => value.id,
    };
  return admitCanonicalKeyset(
    subjects,
    await readSearchIdentityMappings(
      pool,
      subjects.map((subject) => subject.id),
    ),
  );
}
