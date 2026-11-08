import type { KernelClient } from '@rezics/client';
import type { ModerationDirectorySource } from './directory';

/** One installed native page. Authorization is the prepared server credential;
 * native coverage, source and exclusive horizon remain the admission authority. */
export function nativeModerationDirectory(
  client: KernelClient,
  authorization: string,
  signal?: AbortSignal,
): ModerationDirectorySource {
  return async (input, requestSignal = signal) => {
    requestSignal?.throwIfAborted();
    const result = await client.me['moderation-directory'].get({
      headers: { authorization },
      fetch: { cache: 'no-store', ...(requestSignal ? { signal: requestSignal } : {}) },
      query: {
        limit: String(input.limit),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.realmId ? { realmId: input.realmId } : {}),
      },
    });
    requestSignal?.throwIfAborted();
    if (result.error || result.status !== 200) {
      const problem: unknown = result.error?.value;
      const code = problem && typeof problem === 'object' && 'code' in problem ? problem.code : undefined;
      const state =
        (result.status === 400 && code === 'invalid_cursor') || (result.status === 409 && code === 'stale_cursor')
          ? 'stale'
          : [401, 403, 404].includes(result.status)
            ? 'denied'
            : 'unavailable';
      return { state, items: [], next: null };
    }
    // The existing readWorkbench boundary validates and copies the native page.
    return result.data ?? { state: 'unavailable', items: [], next: null };
  };
}
