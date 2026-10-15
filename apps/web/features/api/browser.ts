import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';

/** Mount point of the BFF proxy. Main's paths continue unchanged after it. */
export const BFF_PREFIX = '/api/main';

function recoverBrowserRead(send: typeof fetch): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await send(input, init); }
    catch (error) {
      const request = input instanceof Request ? input : null;
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const signal = init?.signal ?? request?.signal;
      // A network change can cancel a healthy read before any HTTP answer exists.
      // Repeat it once unchanged; commands and received refusals belong to their callers.
      if (!(error instanceof TypeError) || signal?.aborted || method !== 'GET' && method !== 'HEAD') throw error;
      return send(input, init);
    }
  }, { preconnect: send.preconnect });
}

/** Browser Eden client for Main through the BFF: the same `MainApp` type as
 * `mainApi()`, with the session cookie standing in for the bearer token. Send
 * an `Idempotency-Key` header on commands exactly as Main documents it.
 * Display languages are attached by the BFF from Main when the reader is
 * signed in, and from the content-language cookie only when they are not. */
export function browserMainApi(
  origin: string = window.location.origin,
  { anonymous = false, cache, fetcher }: { anonymous?: boolean; cache?: RequestCache; fetcher?: typeof fetch } = {},
) {
  return treaty<MainApp>(`${origin}${BFF_PREFIX}`, {
    headers: () =>
      typeof window === 'undefined' ? {} : { 'x-rezics-page-url': window.location.href },
    // A public reader without an eligible Agent must not send an authenticated
    // request with no actingSubject (Main rejects that ambiguous authority).
    fetch: { credentials: anonymous ? 'omit' : 'same-origin', ...(cache ? { cache } : {}) },
    fetcher: recoverBrowserRead(fetcher ?? fetch),
    // Date-shaped JSON stays text. A literal's lexical form is the string Main recorded.
    parseDate: false,
  });
}
