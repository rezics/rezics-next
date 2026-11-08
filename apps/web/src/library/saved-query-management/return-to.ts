import { admitMineCollectionsAddress, mineCollectionsCursorLimit } from '../mine-collections-address';

const returnOrigin = 'https://rezics.invalid';

/** Finite encoded envelope for an admitted directory cursor, including non-ASCII text. */
export function savedQueryReturnToLimit(locale: string): number {
  const path = `/${encodeURIComponent(locale)}/library/collections`;
  // Three percent-encoded UTF-8 bytes need at most nine characters per UTF-16 unit.
  return (
    returnOrigin.length + path.length + '?cursor='.length + mineCollectionsCursorLimit * 9 + '&layout=previews'.length
  );
}

/** A delete return can address only the same locale's bounded My Collections page. */
export function savedQueryReturnTo(value: string | undefined, locale: string): string {
  const path = `/${encodeURIComponent(locale)}/library/collections`;
  if (!value || value.length > savedQueryReturnToLimit(locale)) return path;
  let destination: URL;
  try {
    destination = new URL(value, returnOrigin);
  } catch {
    return path;
  }
  if (
    destination.origin !== returnOrigin ||
    destination.pathname !== path ||
    value.includes('#') ||
    [...destination.searchParams.keys()].some((key) => key !== 'cursor' && key !== 'layout') ||
    destination.searchParams.getAll('cursor').length > 1 ||
    destination.searchParams.getAll('layout').length > 1
  )
    return path;
  const address = admitMineCollectionsAddress({
    cursor: destination.searchParams.get('cursor') ?? undefined,
    layout: destination.searchParams.get('layout') ?? undefined,
  });
  if (address.addressError) return path;
  return `${destination.pathname}${destination.search}`;
}
