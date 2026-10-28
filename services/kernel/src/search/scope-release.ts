import type { FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { activeRelease, readRelease } from '../semantic/definitions.ts';

const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Resolve the immutable filter definition selected for Search scope admission. */
export async function readSearchScopeRelease(
  pool: Pool,
  releaseDigest?: string,
): Promise<{ digest: string; release: FilterRelease } | null> {
  if (releaseDigest === undefined) {
    const active = await activeRelease(pool);
    if (!active || RELEASE_DIGEST.exec(active.digest)?.[0] !== active.digest) return null;
    return { digest: active.digest, release: active.release };
  }

  if (RELEASE_DIGEST.exec(releaseDigest)?.[0] !== releaseDigest) return null;
  const release = await readRelease(pool, releaseDigest);
  return release ? { digest: releaseDigest, release } : null;
}
