import { admitMineCollectionsAddress, mineCollectionsCursorLimit } from '../mine-collections-address';

const returnOrigin = 'https://rezics.invalid';

/** A delete return can address only the same locale's bounded My Collections page. */
export function savedQueryReturnTo(value: string | undefined, locale: string): string {
  const path = `/${encodeURIComponent(locale)}/library/collections`;
  // URLSearchParams needs at most nine ASCII characters per UTF-16 cursor unit
  // (three percent-encoded UTF-8 bytes), plus the origin, path and fixed operands.
  const encodedLimit =
    returnOrigin.length + path.length + '?cursor='.length + mineCollectionsCursorLimit * 9 + '&layout=previews'.length;
  if (!value || value.length > encodedLimit) return path;
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
