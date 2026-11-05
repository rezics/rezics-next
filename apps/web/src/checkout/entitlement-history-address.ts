import { purchaseHistoryHref, type PurchaseHistoryPosition } from './purchase-return';

export type EntitlementHistoryAddress = { kind: 'list'; cursor?: string } | { kind: 'malformed' };

export function entitlementHistoryAddress(search: Record<string, unknown>): EntitlementHistoryAddress {
  const cursor = search.cursor;
  if (cursor === undefined || cursor === '') return { kind: 'list' };
  if (typeof cursor !== 'string' || cursor.length > 4096) return { kind: 'malformed' };
  return { kind: 'list', cursor };
}

export async function loadEntitlementHistoryAddress<T>(
  address: EntitlementHistoryAddress,
  read: (cursor?: string) => Promise<T>,
): Promise<T | { kind: 'malformed-address' }> {
  if (address.kind === 'malformed') return { kind: 'malformed-address' };
  return read(address.cursor);
}

export function entitlementHistoryRepairHref(locale: string, history: PurchaseHistoryPosition): string {
  return purchaseHistoryHref(locale, 'entitlements', { ...history, entitlementsCursor: undefined });
}
