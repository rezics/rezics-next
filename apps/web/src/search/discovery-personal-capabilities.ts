import type { Release } from '../subject/definitions';
import { libraryProfile, libraryStateOptions } from '../library/profiles';
import type { DiscoveryPage, DiscoveryState } from './discovery';
import type { DiscoveryEntryCapability } from './discovery-personal-actions';

export type DiscoveryCapabilityPage = {
  release: string;
  exposure: string;
  entries: Record<string, DiscoveryEntryCapability>;
  vote: boolean;
};
export function discoveryExposureKey(admitted: readonly string[]) {
  return JSON.stringify([...admitted].sort());
}
/** One projection per released kind, separate from entry existence. The envelope never enters a public cache. */
export function discoveryCapabilities(
  page: DiscoveryPage,
  release: Release | undefined,
  admitted: readonly string[] | undefined,
  locale: string,
): DiscoveryCapabilityPage {
  const entries: DiscoveryCapabilityPage['entries'] = Object.create(null);
  const personal = admitted?.includes('personal_library') ?? false;
  for (const hit of page.hits) {
    if (hit.summary.kind !== 'subject' || Object.hasOwn(entries, hit.key.kind)) continue;
    entries[hit.key.kind] = !admitted
      ? { state: 'unavailable' }
      : !personal
        ? { state: 'concealed' }
        : !release
          ? { state: 'unavailable' }
          : !libraryProfile(release, hit.key.kind)
            ? { state: 'unsupported' }
            : {
                state: 'ready',
                states: libraryStateOptions(release, hit.key.kind, locale),
                save: true,
                remove: admitted?.includes('library_entry.delete') ?? false,
              };
  }
  return {
    release: release?.digest ?? '',
    exposure: admitted ? discoveryExposureKey(admitted) : '',
    entries,
    vote: personal,
  };
}
export function boundDiscoveryPrivateBytes(state: DiscoveryState, capabilities: DiscoveryCapabilityPage | null) {
  return new TextEncoder().encode(
    JSON.stringify({
      collectionFollows: state.status === 'ready' ? state.page.collectionFollows : null,
      viewerFacts: state.status === 'ready' ? state.page.viewerFacts : null,
      capabilities,
    }),
  ).byteLength;
}

/** All capability transports share one byte/chunk allowance; an oversized release withholds writes. */
export function discoveryMetadataFetch(signal: AbortSignal) {
  let remaining = 1048576,
    chunks = 1024;
  return (fetcher: typeof fetch): typeof fetch =>
    (async (input, init) => {
      const response = await fetcher(input, { ...init, signal, cache: 'no-store' });
      if (!response.body) return response;
      const reader = response.body.getReader();
      const parts: ArrayBuffer[] = [];
      try {
        while (true) {
          signal.throwIfAborted();
          if (chunks-- <= 0) throw new RangeError('Discovery capability metadata exceeds its chunk bound');
          const next = await reader.read();
          if (next.done) break;
          remaining -= next.value.byteLength;
          if (remaining < 0) throw new RangeError('Discovery capability metadata exceeds its byte bound');
          parts.push(Uint8Array.from(next.value).buffer);
        }
        return new Response(new Blob(parts), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }) as typeof fetch;
}
