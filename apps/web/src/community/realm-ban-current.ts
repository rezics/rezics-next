/** Failure-only seam until the installed generated ban page admits exact selection. */
export type RealmBanCurrentInput = Readonly<{ realmId: string; accountId: string }>;
export type RealmBanCurrentFailure = { state: 'unavailable' | 'forbidden' | 'signed-out' | 'closed' };
export type InspectRealmBanCurrent = (input: RealmBanCurrentInput) => Promise<RealmBanCurrentFailure>;

export const unavailableRealmBanCurrent: InspectRealmBanCurrent = async () => ({ state: 'unavailable' });

export function currentBanAccountKey(value: string): string | null {
  const key = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key) ? key : null;
}
