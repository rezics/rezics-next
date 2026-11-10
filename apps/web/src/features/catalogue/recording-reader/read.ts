import type { KernelClient } from '@rezics/client';
import { RELEASE_FORMAT, releaseDigest, type Release } from '@rezics/definitions';

export type RecordingReleaseRead =
  | { ok: false; reason: 'unavailable' }
  | { ok: true; digest: string; release: Release };

/** The exact release on the current public Subject read owns the fields shown by its Recording reader. */
export async function readRecordingRelease(client: KernelClient, digest: string): Promise<RecordingReleaseRead> {
  if (!digest || digest.length > 128) return { ok: false, reason: 'unavailable' };
  try {
    const result = await client.definitions.releases({ digest }).get();
    if (result.status !== 200 || !result.data || result.data.digest !== digest || !result.data.release)
      return { ok: false, reason: 'unavailable' };
    // The API validates the release before serving it; the portable digest binds it to this read.
    const release = result.data.release as Release;
    if (release.format !== RELEASE_FORMAT || releaseDigest(release) !== digest)
      return { ok: false, reason: 'unavailable' };
    return { ok: true, digest, release };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
