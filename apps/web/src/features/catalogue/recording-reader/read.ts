import type { KernelClient } from '@rezics/client';
import { validateRelease, type Release } from '@rezics/definitions';

export type RecordingReleaseRead =
  | { ok: false; reason: 'unavailable' }
  | { ok: true; digest: string; release: Release };

function isRelease(value: unknown): value is Release {
  try {
    return validateRelease(value).length === 0;
  } catch {
    return false;
  }
}

/** The exact release on the current public Subject read owns the fields shown by its Recording reader. */
export async function readRecordingRelease(client: KernelClient, digest: string): Promise<RecordingReleaseRead> {
  if (!digest || digest.length > 128) return { ok: false, reason: 'unavailable' };
  try {
    const result = await client.definitions.releases({ digest }).get();
    if (result.status !== 200 || !result.data || result.data.digest !== digest || !result.data.release)
      return { ok: false, reason: 'unavailable' };
    if (!isRelease(result.data.release)) return { ok: false, reason: 'unavailable' };
    return { ok: true, digest, release: result.data.release };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
