import type { RealmClaimSnapshot } from '../community/realm-claim';
import realm from '../kernel/recorded/realm.json';

/** Explicit illustrative owned source for the original community fixture, never an ownership inference.
 * Presentation references/previews remain absent; participation, Access and commands keep their own responses.
 */
export const communityCurrentClaim: RealmClaimSnapshot = {
  realmId: realm.realm.realmId,
  spaceId: realm.realm.spaceId,
  contextId: realm.realm.contextId,
  headRevisionId: realm.realm.headRevisionId,
  ownershipState: 'owned',
  orphanedAt: null,
  claimEligibleAt: null,
  governanceReadOnly: false,
};

/** Opt-in only: the anonymous page and the existing story session read one matching native source. */
export function withCommunityCurrentClaim(previous: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Relative browser requests belong to the existing browser adapter, not the kernel recording.
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://rezics.local');
    if (url.origin !== 'http://kernel.local' || url.pathname !== `/v1/realms/${communityCurrentClaim.realmId}`)
      return previous(input, init);
    const request = new Request(input, init);
    const authorization = request.headers.get('authorization');
    if (request.method !== 'GET' || (authorization !== null && authorization !== 'Bearer recorded-story-token'))
      return previous(input, init);
    return Response.json({ ...realm, realm: { ...realm.realm, ...communityCurrentClaim } });
  }) as typeof fetch;
}

/** Storybook runs this before rendering and restores the complete preceding adapter on cleanup. */
export function communityCurrentClaimStory() {
  const previous = globalThis.fetch;
  globalThis.fetch = withCommunityCurrentClaim(previous);
  return () => {
    globalThis.fetch = previous;
  };
}
