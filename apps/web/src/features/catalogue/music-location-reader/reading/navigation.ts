import type { MusicLocationAddress, MusicLocationRead } from '../model';

type Ready = Extract<MusicLocationRead, { ok: true }>;
export type NavigationIntent = 'open' | 'stream' | 'more' | 'previous' | 'start';
export type Request = { address: MusicLocationAddress; intent: NavigationIntent };
export type Accepted = { page: Ready; address: MusicLocationAddress };
export type Navigation = {
  accepted?: Accepted | undefined;
  /** Only opaque addresses, never old pages or summaries. The last entry is current. */
  trail: MusicLocationAddress[];
  evicted: boolean;
};
export const maximumAddresses = 8;

/** Preserve the exact request, including its original causal session. */
export function acceptedAddress(address: MusicLocationAddress, page: Ready): MusicLocationAddress {
  return { ...address, ...(page.stream ? { stream: page.stream.key } : {}) };
}

export function accept(navigation: Navigation, request: Request, page: Ready): Navigation {
  const address = acceptedAddress(request.address, page);
  let trail: MusicLocationAddress[];
  let evicted = navigation.evicted;
  switch (request.intent) {
    case 'previous':
      trail = [...navigation.trail.slice(0, -2), address];
      break;
    case 'more':
      trail = [...navigation.trail, address];
      if (trail.length > maximumAddresses) {
        // Evict oldest first. Going back never invents the address beyond this boundary.
        trail = trail.slice(-maximumAddresses);
        evicted = true;
      }
      break;
    default:
      trail = [address];
      evicted = false;
  }
  return { accepted: { page, address }, trail, evicted };
}

export function previousAddress(navigation: Navigation): MusicLocationAddress | undefined {
  return navigation.trail.at(-2);
}

/** New forward navigation chains the native result session; back/retry use stored addresses unchanged. */
export function streamStart(
  snapshot: MusicLocationAddress,
  stream: string | undefined,
  accepted: Accepted | undefined,
): MusicLocationAddress {
  return {
    ...snapshot,
    ...(stream ? { stream } : {}),
    ...(accepted?.page.session ? { session: accepted.page.session } : {}),
  };
}
