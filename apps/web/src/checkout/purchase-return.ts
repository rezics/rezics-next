/** Navigation positions only: neither cursor supplies payment or current Access authority. */
export type PurchaseHistoryPosition = {
  ordersCursor?: string | undefined;
  entitlementsCursor?: string | undefined;
};

export type PurchaseReaderOrigin = {
  version: 1;
  kind: 'order' | 'entitlement';
  recordId: string;
  editionId: string;
  locale: string;
  history: PurchaseHistoryPosition;
  viewerSubject: string;
  viewerReadId: number;
  runtimeId: string;
};

export type PurchaseReaderViewer = {
  current: boolean;
  subject: string | null;
  readId: number | undefined;
};

const identifierPattern = /^[^/\\\u0000-\u001f]{1,128}$/;
const localePattern = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const runtimeId = globalThis.crypto?.randomUUID?.();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && identifierPattern.test(value) && value !== '.' && value !== '..';
}

function validHistoryPosition(value: unknown): PurchaseHistoryPosition | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  for (const key of ['ordersCursor', 'entitlementsCursor'] as const) {
    const cursor = value[key];
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096))
      return undefined;
  }
  return purchaseHistorySearch(value);
}

/** Capture navigation coordinates only for a currently admitted buyer visit. */
export function createPurchaseReaderOrigin(input: {
  kind: PurchaseReaderOrigin['kind'];
  recordId: string;
  editionId: string;
  locale: string;
  history?: PurchaseHistoryPosition | undefined;
  viewer: PurchaseReaderViewer;
}): PurchaseReaderOrigin | undefined {
  const history = validHistoryPosition(input.history);
  if (
    !runtimeId ||
    !input.viewer.current ||
    !validIdentifier(input.recordId) ||
    !validIdentifier(input.editionId) ||
    !localePattern.test(input.locale) ||
    !history ||
    !validIdentifier(input.viewer.subject) ||
    !Number.isSafeInteger(input.viewer.readId) ||
    input.viewer.readId! < 1
  )
    return undefined;
  return {
    version: 1,
    kind: input.kind,
    recordId: input.recordId,
    editionId: input.editionId,
    locale: input.locale,
    history,
    viewerSubject: input.viewer.subject,
    viewerReadId: input.viewer.readId!,
    runtimeId,
  };
}

/** Route state is untrusted and valid only in the same app runtime and for the exact reader address. */
export function purchaseReaderOriginFromState(
  state: unknown,
  editionId: string,
  locale: string,
): PurchaseReaderOrigin | undefined {
  if (!isRecord(state) || !isRecord(state.purchaseOrigin)) return undefined;
  const value = state.purchaseOrigin;
  const history = validHistoryPosition(value.history);
  if (
    value.version !== 1 ||
    (value.kind !== 'order' && value.kind !== 'entitlement') ||
    !validIdentifier(value.recordId) ||
    value.editionId !== editionId ||
    value.locale !== locale ||
    !history ||
    !validIdentifier(value.viewerSubject) ||
    !Number.isSafeInteger(value.viewerReadId) ||
    (value.viewerReadId as number) < 1 ||
    typeof value.runtimeId !== 'string' ||
    value.runtimeId !== runtimeId
  )
    return undefined;
  return {
    version: 1,
    kind: value.kind,
    recordId: value.recordId,
    editionId,
    locale,
    history,
    viewerSubject: value.viewerSubject,
    viewerReadId: value.viewerReadId as number,
    runtimeId,
  };
}

/** Re-admit the originating inventory operation before exposing its private return address. */
export function purchaseReaderOriginIsCurrent(
  origin: PurchaseReaderOrigin,
  editionId: string,
  locale: string,
  viewer: PurchaseReaderViewer,
): boolean {
  return (
    origin.runtimeId === runtimeId &&
    origin.editionId === editionId &&
    origin.locale === locale &&
    viewer.current &&
    viewer.subject === origin.viewerSubject &&
    viewer.readId === origin.viewerReadId
  );
}

/** Build only the two supported private detail destinations; no arbitrary return URL is accepted. */
export function purchaseReaderOriginHref(origin: PurchaseReaderOrigin): string {
  const detail = `${origin.kind === 'order' ? 'orders' : 'entitlements'}/${encodeURIComponent(origin.recordId)}` as const;
  return purchaseHistoryHref(origin.locale, detail, origin.history);
}

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
