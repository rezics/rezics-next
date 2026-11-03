import type { BanReadState, InstalledRealmBanPage, RealmBanPage, RealmBanRow } from './realm-bans';

/** Web inspection seam; generated delivery must supply the native exact observation. */
export type RealmBanCurrentInput = Readonly<{ realmId: string; accountId: string; cursor?: string }>;
export type RealmBanCurrentFailure = { state: 'unavailable' | 'forbidden' | 'signed-out' | 'closed' };
export type RealmBanCurrentObservation =
  | { state: 'current'; input: RealmBanCurrentInput; ban: Readonly<RealmBanPage['items'][number]> }
  | { state: 'absent'; input: RealmBanCurrentInput; account?: InstalledRealmBanPage['items'][number]['account'] };
export type RealmBanCurrentResult = RealmBanCurrentFailure | RealmBanCurrentObservation;
export type InspectRealmBanCurrent = (input: RealmBanCurrentInput) => Promise<RealmBanCurrentResult>;

// Standalone callers without an installed adapter cannot infer exact absence.
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
    ? Object.freeze({ state: 'current', input: bound, ban: copyRealmBanEpisode(result.ban) })
    : Object.freeze({
        state: 'absent',
        input: bound,
        ...(result.account ? { account: Object.freeze({ ...result.account }) } : {}),
      });
}

export function currentBanAccountKey(value: string): string | null {
  const key = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key) ? key : null;
}

/** Copy every composed observation used by confirmation, including nested identity and advice. */
export function copyRealmBanEpisode(ban: RealmBanRow): Readonly<RealmBanRow> {
  return Object.freeze({
    ...ban,
    ...(ban.account ? { account: Object.freeze({ ...ban.account }) } : {}),
    ...(ban.moderator ? { moderator: Object.freeze({ ...ban.moderator }) } : {}),
    ...(ban.unban ? { unban: Object.freeze({ ...ban.unban }) } : {}),
    ...(ban.removal ? { removal: Object.freeze({ ...ban.removal }) } : {}),
  });
}

/** Only an admitted native exact observation can establish operational absence. */
export function observeRealmBanCurrent(input: RealmBanCurrentInput, read: BanReadState): RealmBanCurrentResult {
  if (read.state !== 'ready') {
    return read.state === 'forbidden' || read.state === 'signed-out' || read.state === 'closed'
      ? { state: read.state }
      : { state: 'unavailable' };
  }
  const selected = read.page.selected;
  if (!selected || selected.state === 'not-requested') return { state: 'unavailable' };
  if (read.page.viewer?.unban.resource.id !== input.realmId) return { state: 'unavailable' };
  if (selected.state === 'absent') {
    if (selected.accountId !== input.accountId || selected.account.accountId !== input.accountId)
      return { state: 'unavailable' };
    return admitRealmBanCurrent(input, { state: 'absent', input, account: selected.account });
  }
  if (!realmBanEpisodeAdvice(selected.ban, input.realmId) || selected.ban.accountId !== input.accountId)
    return { state: 'unavailable' };
  return admitRealmBanCurrent(input, { state: 'current', input, ban: selected.ban });
}

/** Advice binds this observed episode, while the original writer still reauthorizes. */
export function realmBanEpisodeAdvice(ban: RealmBanRow, realmId: string): boolean {
  const advice = ban.unban;
  return (
    !!advice &&
    advice.state === 'permitted' &&
    advice.realmId === realmId &&
    advice.accountId === ban.accountId &&
    advice.observedAt === ban.at &&
    advice.membershipRestored === false
  );
}
