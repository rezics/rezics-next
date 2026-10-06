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

/** What Main and this build say about a Zone's official package, independent of what the reader asked for. */
interface Approval {
  /** Main's report, or null when the Realm has no Zone. */
  main: MainExecution | null;
  /** The official route segment, or null for a community Zone. */
  slug: string | null;
  /** The digest of this build's package for `slug`, or null when it carries none. */
  installedDigest: string | null;
}

/** The reason the package may not run, or null when Main's approval names exactly the package this build carries. */
export function unapproved({ main, slug, installedDigest }: Approval): FallbackReason | null {
  if (!main || !slug) return 'none-approved';
  if (!main.approved) return main.reason;
  if (!installedDigest) return 'not-installed';
  if (installedDigest !== main.approved.digest) return 'digest-mismatch';
  return null;
}

/**
 * Whether this view runs the Zone's official package. Every fence must hold:
 * the reader has not asked for safe mode or the standard look, Main reports an
 * active approval, and the approved digest is exactly the package this build
 * carries. Anything else renders the Zone's complete token-and-layout fallback.
 */
export function decideExecution({ main, slug, installedDigest, safeMode, lookEnabled }: Approval & {
  safeMode: boolean;
  lookEnabled: boolean;
}): Execution {
  if (!lookEnabled) return { mode: 'fallback', reason: 'viewer-opt-out' };
  if (safeMode) return { mode: 'fallback', reason: 'safe-mode' };
  const reason = unapproved({ main, slug, installedDigest });
  return reason || !slug ? { mode: 'fallback', reason: reason ?? 'none-approved' } : { mode: 'package', slug };
}

/**
 * The approved package whose data declarations (the positions and continuities it reads) apply to this view, or null.
 * Safe mode and the standard look switch off the package's presentation code, never the reader's chosen position or
 * continuity: the package is read for what it declares, and only when the same approval fences hold.
 */
export function declaringSlug(approval: Approval): string | null {
  return unapproved(approval) ? null : approval.slug;
}
