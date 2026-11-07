import { getLocale } from '../paraglide/runtime.js';
import { profileCommandValues, type ProfileValues } from './profile-model';
import { isWatchReturnReceipt, type WatchReturnReceipt } from './watch-controller';

export const settingsWatchReturnKey = '__rezicsSettingsWatchReturn';
export const settingsReturnByteLimit = 65_536;

export type ProfileReturnSnapshot = Readonly<{
  known: ProfileValues;
  draft: ProfileValues;
  lastFocus?: string;
}>;

export type SettingsWatchReturnCarrier = Readonly<{
  version: 1;
  origin: string;
  pathname: string;
  hash: string;
  locale: string;
  receipt: WatchReturnReceipt;
  profile?: ProfileReturnSnapshot | null;
}>;

const profileFocusFields = new Set(['displayName', 'biography', 'avatar', 'links']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fitsBudget(value: unknown, limit = settingsReturnByteLimit): boolean {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' && new TextEncoder().encode(encoded).byteLength <= limit;
  } catch {
    return false;
  }
}

function validProfileValues(value: unknown): value is ProfileValues {
  if (!record(value) || typeof value.accountId !== 'string' || value.accountId.length === 0) return false;
  if (value.kind !== 'actor' && value.kind !== 'organization') return false;
  if (value.displayName !== null && (typeof value.displayName !== 'string' || value.displayName.length > 4096))
    return false;
  if (value.biography !== null && (typeof value.biography !== 'string' || value.biography.length > 4096)) return false;
  if (value.avatar !== null && (!record(value.avatar) || typeof value.avatar.media !== 'string')) return false;
  if (!Array.isArray(value.links) || value.links.length > 5) return false;
  if (
    !value.links.every(
      (link) =>
        record(link) &&
        typeof link.label === 'string' &&
        Array.from(link.label).length <= 64 &&
        typeof link.url === 'string' &&
        Array.from(link.url).length <= 2048,
    )
  )
    return false;
  if (!record(value.publicViews)) return false;
  for (const flag of ['posts', 'reviews', 'collections', 'realms'] as const)
    if (typeof value.publicViews[flag] !== 'boolean') return false;
  if (value.kind === 'organization' && value.speakersListed !== undefined && typeof value.speakersListed !== 'boolean')
    return false;
  return true;
}

/** Same-tab Profile draft for a disclosed Watch visit; never a native projection or command receipt. */
export function isProfileReturnSnapshot(value: unknown): value is ProfileReturnSnapshot {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'draft,known' && keys !== 'draft,known,lastFocus') return false;
  if (
    value.lastFocus !== undefined &&
    (typeof value.lastFocus !== 'string' || !profileFocusFields.has(value.lastFocus))
  )
    return false;
  if (!validProfileValues(value.known) || !validProfileValues(value.draft)) return false;
  if (value.known.accountId !== value.draft.accountId || value.known.kind !== value.draft.kind) return false;
  return fitsBudget(value);
}

export function captureProfileReturn(
  known: ProfileValues | null,
  draft: ProfileValues | null,
  lastFocus?: string,
): ProfileReturnSnapshot | null {
  if (!known || !draft) return null;
  const snapshot: ProfileReturnSnapshot = {
    known: profileCommandValues(known),
    draft: profileCommandValues(draft),
    ...(lastFocus && profileFocusFields.has(lastFocus) ? { lastFocus } : {}),
  };
  return isProfileReturnSnapshot(snapshot) ? snapshot : null;
}

export function readSettingsWatchReturn(state: unknown): {
  receipt: WatchReturnReceipt | null;
  profile: ProfileReturnSnapshot | null;
  present: boolean;
} {
  if (typeof globalThis.window === 'undefined' || !record(state))
    return { receipt: null, profile: null, present: false };
  const value = state[settingsWatchReturnKey];
  if (value === undefined) return { receipt: null, profile: null, present: false };
  const keys = record(value) ? Object.keys(value).sort().join(',') : '';
  const carrier = value as Partial<SettingsWatchReturnCarrier>;
  const current = globalThis.window.location;
  const valid =
    keys === 'hash,locale,origin,pathname,receipt,version' ||
    keys === 'hash,locale,origin,pathname,profile,receipt,version';
  if (
    !valid ||
    carrier.version !== 1 ||
    carrier.origin !== current.origin ||
    carrier.pathname !== current.pathname ||
    carrier.hash !== current.hash ||
    carrier.locale !== getLocale() ||
    !isWatchReturnReceipt(carrier.receipt) ||
    (carrier.profile != null && !isProfileReturnSnapshot(carrier.profile)) ||
    !fitsBudget(value)
  )
    return { receipt: null, profile: null, present: true };
  return { receipt: carrier.receipt, profile: carrier.profile ?? null, present: true };
}

export function withoutSettingsWatchReturn(state: unknown): Record<string, unknown> {
  const next = record(state) ? { ...state } : {};
  delete next[settingsWatchReturnKey];
  return next;
}

export function settingsWatchReturnCarrier(
  receipt: WatchReturnReceipt,
  profile: ProfileReturnSnapshot | null,
): SettingsWatchReturnCarrier | null {
  if (typeof globalThis.window === 'undefined' || !isWatchReturnReceipt(receipt)) return null;
  const current = globalThis.window.location;
  const carrier: SettingsWatchReturnCarrier = {
    version: 1,
    origin: current.origin,
    pathname: current.pathname,
    hash: current.hash,
    locale: getLocale(),
    receipt,
    ...(profile ? { profile } : {}),
  };
  return fitsBudget(carrier) ? carrier : { ...carrier, profile: null };
}
