/** Bounded text only: never render arbitrary search objects or turn them into a list selector. */
export type MineCollectionsAddressError = { cursor?: string; layout?: string };
export type MineCollectionsSearch = {
  cursor?: string;
  layout: 'rows' | 'previews';
  addressError?: MineCollectionsAddressError;
};

function describe(value: unknown): string {
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 159)}…` : value;
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

/** Shared, idempotent admission for raw router search and server-function input. */
export function admitMineCollectionsAddress(input: unknown): MineCollectionsSearch {
  const source = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const errors: MineCollectionsAddressError = {};
  // The router carries bounded invalid context to the server without substituting a valid first page.
  if (source.addressError !== undefined) {
    const prior = source.addressError;
    if (prior && typeof prior === 'object' && ('cursor' in prior || 'layout' in prior)) {
      if ('cursor' in prior) errors.cursor = describe(prior.cursor);
      if ('layout' in prior) errors.layout = describe(prior.layout);
    } else errors.cursor = describe(prior);
  }
  if (input !== undefined && (!input || typeof input !== 'object')) errors.cursor = describe(input);
  if (
    source.cursor !== undefined &&
    (typeof source.cursor !== 'string' || source.cursor.length === 0 || source.cursor.length > 4096)
  )
    errors.cursor =
      typeof source.cursor === 'string' && source.cursor.length === 0 ? 'empty string' : describe(source.cursor);
  if (source.layout !== undefined && source.layout !== 'rows' && source.layout !== 'previews')
    errors.layout = describe(source.layout);
  return {
    ...(typeof source.cursor === 'string' && source.cursor.length > 0 && source.cursor.length <= 4096
      ? { cursor: source.cursor }
      : {}),
    layout: source.layout === 'previews' ? 'previews' : 'rows',
    ...(Object.keys(errors).length ? { addressError: errors } : {}),
  };
}
