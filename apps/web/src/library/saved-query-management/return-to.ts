const returnOrigin = 'https://rezics.invalid';

/** A delete return can address only the same locale's bounded My Collections page. */
export function savedQueryReturnTo(value: string | undefined, locale: string): string {
  const path = `/${encodeURIComponent(locale)}/library/collections`;
  if (!value || value.length > 4096) return path;
  let destination: URL;
  try {
    destination = new URL(value, returnOrigin);
  } catch {
    return path;
  }
  if (
    destination.origin !== returnOrigin ||
    destination.pathname !== path ||
    destination.hash ||
    [...destination.searchParams.keys()].some((key) => key !== 'cursor' && key !== 'layout') ||
    destination.searchParams.getAll('cursor').length > 1 ||
    destination.searchParams.getAll('layout').length > 1
  )
    return path;
  const cursor = destination.searchParams.get('cursor');
  const layout = destination.searchParams.get('layout');
  if (
    (cursor !== null && (!cursor.length || cursor.length > 2048)) ||
    (layout !== null && !['rows', 'previews'].includes(layout))
  )
    return path;
  return `${destination.pathname}${destination.search}`;
}
