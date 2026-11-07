/** Public directory selection. Labels and private rules never form part of this address. */
export type PublicCollectionDirectorySelection = Readonly<{
  presentationKind?: string;
  curator?: string;
  subject?: string;
  order?: 'recent' | 'popular';
}>;
export type PublicCollectionDirectoryAddress = PublicCollectionDirectorySelection & Readonly<{ cursor?: string }>;
export type PublicCollectionDirectoryAddressResult =
  | { state: 'ready'; address: PublicCollectionDirectoryAddress }
  | { state: 'invalid'; field: keyof PublicCollectionDirectoryAddress };

export const publicCollectionCursorLimit = 4864;
const canonicalIdentity = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** This parser is for the browser boundary; native callers use the typed selection directly. */
export function parsePublicCollectionDirectoryAddress(
  search: Record<string, unknown>,
): PublicCollectionDirectoryAddressResult {
  const address: {
    presentationKind?: string;
    curator?: string;
    subject?: string;
    order?: 'recent' | 'popular';
    cursor?: string;
  } = {};
  const kind = search.presentationKind;
  if (kind !== undefined && kind !== '') {
    if (typeof kind !== 'string' || kind.length > 256) return { state: 'invalid', field: 'presentationKind' };
    address.presentationKind = kind;
  }
  for (const field of ['curator', 'subject'] as const) {
    const value = search[field];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || !canonicalIdentity.test(value)) return { state: 'invalid', field };
    address[field] = value;
  }
  const order = search.order;
  if (order !== undefined && order !== '') {
    if (order !== 'recent' && order !== 'popular') return { state: 'invalid', field: 'order' };
    address.order = order;
  }
  const cursor = parsePublicCollectionCursor(search.cursor);
  if (cursor.state === 'invalid') return { state: 'invalid', field: 'cursor' };
  if (cursor.cursor !== undefined) address.cursor = cursor.cursor;
  return { state: 'ready', address };
}

export function parsePublicCollectionCursor(
  cursor: unknown,
): { state: 'ready'; cursor?: string } | { state: 'invalid' } {
  if (cursor === undefined) return { state: 'ready' };
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > publicCollectionCursorLimit)
    return { state: 'invalid' };
  return { state: 'ready', cursor };
}

/** A committed selection always starts at its first page, even when reselecting the same values. */
export function selectPublicCollectionDirectory(
  selection: PublicCollectionDirectorySelection,
): PublicCollectionDirectoryAddress {
  return {
    ...(selection.presentationKind === undefined ? {} : { presentationKind: selection.presentationKind }),
    ...(selection.curator === undefined ? {} : { curator: selection.curator }),
    ...(selection.subject === undefined ? {} : { subject: selection.subject }),
    ...(selection.order === undefined ? {} : { order: selection.order }),
  };
}

/** Native continuation replaces only the cursor; restart retains the entire committed selection. */
export function continuePublicCollectionDirectory(
  address: PublicCollectionDirectoryAddress,
  cursor?: string,
): PublicCollectionDirectoryAddress {
  return { ...selectPublicCollectionDirectory(address), ...(cursor === undefined ? {} : { cursor }) };
}

export function publicCollectionDirectoryHref(locale: string, address: PublicCollectionDirectoryAddress = {}): string {
  const query = new URLSearchParams();
  for (const field of ['presentationKind', 'curator', 'subject', 'order', 'cursor'] as const) {
    const value = address[field];
    if (value !== undefined) query.set(field, value);
  }
  const suffix = query.toString();
  return `/${locale}/collections${suffix ? `?${suffix}` : ''}`;
}
