/** Navigation positions only: neither cursor supplies payment or current Access authority. */
export type PurchaseHistoryPosition = {
  ordersCursor?: string | undefined;
  entitlementsCursor?: string | undefined;
};

/** Ignore malformed optional return positions without invalidating an otherwise readable receipt. */
export function purchaseHistorySearch(search: Record<string, unknown>): PurchaseHistoryPosition {
  const position: PurchaseHistoryPosition = {};
  for (const key of ['ordersCursor', 'entitlementsCursor'] as const) {
    const value = search[key];
    if (typeof value === 'string' && value.length > 0 && value.length <= 4096) position[key] = value;
  }
  return position;
}

type Destination = 'orders' | 'entitlements' | `orders/${string}` | `entitlements/${string}`;

/** Each collection consumes only its own cursor; detail pages carry both positions through unchanged. */
export function purchaseHistoryHref(
  locale: string,
  destination: Destination,
  position: PurchaseHistoryPosition = {},
): string {
  const params: string[] = [];
  const valid = purchaseHistorySearch(position);
  const cursor =
    destination === 'orders'
      ? valid.ordersCursor
      : destination === 'entitlements'
        ? valid.entitlementsCursor
        : undefined;
  if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
  for (const key of ['ordersCursor', 'entitlementsCursor'] as const) {
    // The list's cursor is already in its canonical read parameter.
    if (
      (destination === 'orders' && key === 'ordersCursor') ||
      (destination === 'entitlements' && key === 'entitlementsCursor')
    )
      continue;
    if (valid[key]) params.push(`${key}=${encodeURIComponent(valid[key])}`);
  }
  return `/${locale}/${destination}${params.length ? `?${params.join('&')}` : ''}`;
}
