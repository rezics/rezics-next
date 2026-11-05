/** Admission only: the native owner still authenticates and interprets the opaque position. */
export function continueAddress(input: unknown): { cursor?: string; malformed?: true } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { malformed: true };
  const cursor = 'cursor' in input ? input.cursor : undefined;
  if (cursor === undefined) return {};
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096) return { malformed: true };
  return { cursor };
}

/** Recovery changes page position only; unrelated address fields and the fragment survive. */
export function continueNewestHref(locale: string, search = '', hash = ''): string {
  const params = new URLSearchParams(search);
  params.delete('cursor');
  const query = params.toString();
  return `/${locale}/library/continue${query ? `?${query}` : ''}${hash ? `#${hash.replace(/^#/, '')}` : ''}`;
}

/** Change only Continue's position while keeping other address fields and the fragment. */
export function continueCursorHref(locale: string, search: string, hash: string, cursor: string | null): string {
  const params = new URLSearchParams(search);
  if (cursor === null) params.delete('cursor');
  else params.set('cursor', cursor);
  const query = params.toString();
  return `/${locale}/library/continue${query ? `?${query}` : ''}${hash ? `#${hash.replace(/^#/, '')}` : ''}`;
}
