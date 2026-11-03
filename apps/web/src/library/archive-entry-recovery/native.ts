import type { KernelClient } from '@rezics/client';

/** The generated client is the boundary, even when server source already mounts a route. */
export type GeneratedArchiveRecoveryMethod = Extract<keyof KernelClient, 'libraryArchiveMerges'>;
type ArchiveOwner = ReturnType<KernelClient['libraryArchiveMerges']>;
export type NativeArchiveResults = NonNullable<Awaited<ReturnType<ArchiveOwner['results']['get']>>['data']>;

/**
 * Native source has immutable review confirmation, but the installed generated declaration
 * still omits reviewRevision and accepts ordinal-only apply. Keep admission closed until
 * those generated declarations are published by their existing owner.
 * In particular, ordinal-only apply cannot bind a person's confirmation to the review they saw.
 * Do not probe Eden's runtime proxy: it manufactures properties for undelivered methods too.
 */
export function archiveRecoveryAdmission(): { available: false } {
  return { available: false };
}
