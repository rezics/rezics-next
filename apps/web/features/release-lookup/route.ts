/** Main's bounds on a provider-qualified identifier (`GET /v1/releases?provider=&identifier=`). */
const PROVIDER_MAX = 248;
const IDENTIFIER_MAX = 200;

export interface ReleaseIdentifier { provider: string; identifier: string }

/** A lookup needs both halves, within Main's bounds; anything else is no identifier and Main is not asked. */
export function parseReleaseIdentifier(query: Record<string, string | string[] | undefined>): ReleaseIdentifier | null {
  const provider = typeof query.provider === 'string' ? query.provider.trim() : '';
  const identifier = typeof query.identifier === 'string' ? query.identifier.trim() : '';
  if (!provider || !identifier || provider.length > PROVIDER_MAX || identifier.length > IDENTIFIER_MAX) return null;
  return { provider, identifier };
}

/** The address that resolves a release by a store's own identifier, as `/isbn/{isbn}` does for an ISBN. */
export function releaseLookupHref({ provider, identifier }: ReleaseIdentifier, cursor?: string): string {
  const query = new URLSearchParams({ provider, identifier });
  if (cursor) query.set('cursor', cursor);
  return `/release?${query}`;
}
