import type { KernelClient } from '@rezics/client';
import { locales } from '../paraglide/runtime.js';

// Access handle-policy.ts owns this legacy-compatible lookup syntax (distinct from new claims).
const lookupHandle = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const internalId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type NativeAccount = NonNullable<Awaited<ReturnType<KernelClient['accounts']['get']>>['data']>['accounts'][number];
export type RealmBanTarget = {
  lookupHandle: string;
  account: Extract<NativeAccount, { state: 'active' }> & { handle: string };
};
export type BanTargetState =
  | { state: 'ready'; target: RealmBanTarget }
  | { state: 'idle' | 'pending' | 'invalid' | 'missing' | 'refused' | 'signed-out' | 'unavailable' | 'changed' };
export type ResolveBanTarget = (handle: string, signal: AbortSignal) => Promise<BanTargetState>;

export function normalizeRealmBanTargetHandle(handle: string): string | null {
  return lookupHandle.test(handle) && !internalId.test(handle) ? handle.toLowerCase() : null;
}

/** Only the canonical /@handle overview, optionally prefixed by a supported website locale. */
export function parseRealmBanTarget(value: string, origin: string): string | null {
  let handle = value.trim();
  if (/^https?:\/\//i.test(handle) || handle.startsWith('/')) {
    try {
      const url = new URL(handle, origin);
      if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || url.hash) return null;
      const parts = url.pathname.split('/').slice(1);
      if (parts.length === 2 && locales.some((locale) => locale === parts[0])) parts.shift();
      if (parts.length !== 1 || !parts[0]?.startsWith('@')) return null;
      handle = decodeURIComponent(parts[0].slice(1));
    } catch {
      return null;
    }
  } else if (handle.startsWith('@')) handle = handle.slice(1);
  return normalizeRealmBanTargetHandle(handle);
}

/** A fresh intent must still address the person and current identity the moderator reviewed. */
export async function revalidateRealmBanTarget(
  resolve: ResolveBanTarget,
  reviewed: RealmBanTarget,
  signal: AbortSignal,
): Promise<BanTargetState> {
  const current = await resolve(reviewed.lookupHandle, signal);
  if (signal.aborted) return { state: 'unavailable' };
  if (current.state !== 'ready') return current;
  const before = reviewed.account;
  const after = current.target.account;
  return before.id === after.id &&
    before.handle === after.handle &&
    before.displayName === after.displayName &&
    ('movedTo' in before ? before.movedTo : undefined) === ('movedTo' in after ? after.movedTo : undefined)
    ? current
    : { state: 'changed' };
}
