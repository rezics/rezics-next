/** Validate new claims after case folding; never trim whitespace. */
export const HANDLE_CLAIM_PATTERN = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;
export function isClaimHandle(value: unknown): value is string {
  return typeof value === 'string' && !/\s/.test(value) && HANDLE_CLAIM_PATTERN.test(value.toLowerCase());
}
/** Existing handles remain addressable even when they cannot be newly claimed. */
export const HANDLE_LOOKUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Additions require a reason and a reviewed change. */
export const RESERVED_HANDLES: readonly { handle: string; reason: 'platform' | 'role' | 'mention' }[] = [
  { handle: 'rezics', reason: 'platform' },
  { handle: 'official', reason: 'platform' },
  { handle: 'system', reason: 'platform' },
  { handle: 'root', reason: 'platform' },
  { handle: 'api', reason: 'platform' },
  { handle: 'www', reason: 'platform' },
  { handle: 'mail', reason: 'platform' },
  { handle: 'admin', reason: 'role' },
  { handle: 'administrator', reason: 'role' },
  { handle: 'support', reason: 'role' },
  { handle: 'help', reason: 'role' },
  { handle: 'staff', reason: 'role' },
  { handle: 'team', reason: 'role' },
  { handle: 'moderator', reason: 'role' },
  { handle: 'mod', reason: 'role' },
  { handle: 'security', reason: 'role' },
  { handle: 'abuse', reason: 'role' },
  { handle: 'legal', reason: 'role' },
  { handle: 'privacy', reason: 'role' },
  { handle: 'everyone', reason: 'mention' },
  { handle: 'here', reason: 'mention' },
  { handle: 'anonymous', reason: 'mention' },
  { handle: 'deleted', reason: 'mention' },
  { handle: 'null', reason: 'mention' },
  { handle: 'undefined', reason: 'mention' },
];
const reserved = new Set(RESERVED_HANDLES.map((entry) => entry.handle));
export function isReservedHandle(handle: string): boolean {
  return reserved.has(handle.toLowerCase());
}
