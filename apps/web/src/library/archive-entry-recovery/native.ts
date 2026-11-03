import type { KernelClient } from '@rezics/client';

/** The generated client is the boundary, even when server source already mounts a route. */
export type GeneratedArchiveRecoveryMethod = Extract<keyof KernelClient, 'libraryArchiveMerges'>;

/**
 * Keep admission closed until the native continuation in archive-entry-recovery.md is delivered.
 * In particular, ordinal-only apply cannot bind a person's confirmation to the review they saw.
 * Do not probe Eden's runtime proxy: it manufactures properties for undelivered methods too.
 */
export function archiveRecoveryAdmission(): { available: false } {
  return { available: false };
}
