import type { RealmBanPage } from './realm-bans';

/** Web inspection seam; generated delivery must supply the native exact observation. */
export type RealmBanCurrentInput = Readonly<{ realmId: string; accountId: string; cursor?: string }>;
export type RealmBanCurrentFailure = { state: 'unavailable' | 'forbidden' | 'signed-out' | 'closed' };
export type RealmBanCurrentObservation =
  | { state: 'current'; input: RealmBanCurrentInput; ban: Readonly<RealmBanPage['items'][number]> }
  | { state: 'absent'; input: RealmBanCurrentInput };
export type RealmBanCurrentResult = RealmBanCurrentFailure | RealmBanCurrentObservation;
export type InspectRealmBanCurrent = (input: RealmBanCurrentInput) => Promise<RealmBanCurrentResult>;

// Do not infer exact absence from the original generated list declaration.
export const unavailableRealmBanCurrent: InspectRealmBanCurrent = async () => ({ state: 'unavailable' });

/** An adapter cannot settle one selected account with another Realm, frontier or episode target. */
export function admitRealmBanCurrent(
  input: RealmBanCurrentInput,
  result: RealmBanCurrentResult,
): RealmBanCurrentResult {
  if (result.state !== 'current' && result.state !== 'absent') return result;
  if (
    result.input.realmId !== input.realmId ||
    result.input.accountId !== input.accountId ||
    result.input.cursor !== input.cursor ||
    (result.state === 'current' && result.ban.accountId !== input.accountId)
  )
    return { state: 'unavailable' };
  const bound = Object.freeze({ ...input });
  return result.state === 'current'
    ? Object.freeze({ state: 'current', input: bound, ban: Object.freeze({ ...result.ban }) })
    : Object.freeze({ state: 'absent', input: bound });
}

export function currentBanAccountKey(value: string): string | null {
  const key = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key) ? key : null;
}
