import type { FallbackReason, MainExecution } from './presentation.ts';

/** The cookie a reader sets to see every Zone in the platform's standard look. */
export const ZONE_LOOK_COOKIE = 'rezics_zone_look';

/** `?safe` (any value) shows the Zone's token-and-layout fallback for one view, like Discourse's safe mode. */
export function isSafeMode(search: Record<string, string | string[] | undefined>): boolean {
  return search.safe !== undefined;
}

export function zoneLookEnabled(cookie: string | undefined): boolean {
  return cookie !== 'standard';
}

export type Execution = { mode: 'package'; slug: string } | { mode: 'fallback'; reason: FallbackReason };

/**
 * Whether this view runs the Zone's official package. Every fence must hold:
 * the reader has not asked for safe mode or the standard look, Main reports an
 * active approval, and the approved digest is exactly the package this build
 * carries. Anything else renders the Zone's complete token-and-layout fallback.
 */
export function decideExecution({ main, slug, installedDigest, safeMode, lookEnabled }: {
  /** Main's report, or null when the Realm has no Zone. */
  main: MainExecution | null;
  /** The official route segment, or null for a community Zone. */
  slug: string | null;
  /** The digest of this build's package for `slug`, or null when it carries none. */
  installedDigest: string | null;
  safeMode: boolean;
  lookEnabled: boolean;
}): Execution {
  if (!lookEnabled) return { mode: 'fallback', reason: 'viewer-opt-out' };
  if (safeMode) return { mode: 'fallback', reason: 'safe-mode' };
  if (!main || !slug) return { mode: 'fallback', reason: 'none-approved' };
  if (!main.approved) return { mode: 'fallback', reason: main.reason };
  if (!installedDigest) return { mode: 'fallback', reason: 'not-installed' };
  if (installedDigest !== main.approved.digest) return { mode: 'fallback', reason: 'digest-mismatch' };
  return { mode: 'package', slug };
}
