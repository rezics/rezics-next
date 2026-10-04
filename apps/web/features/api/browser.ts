import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';

/** Mount point of the BFF proxy. Main's paths continue unchanged after it. */
export const BFF_PREFIX = '/api/main';

/** Browser Eden client for Main through the BFF: the same `MainApp` type as
 * `mainApi()`, with the session cookie standing in for the bearer token. Send
 * an `Idempotency-Key` header on commands exactly as Main documents it.
 * Display languages are attached by the BFF from Main when the reader is
 * signed in, and from the content-language cookie only when they are not. */
export function browserMainApi(
  origin: string = window.location.origin,
  { anonymous = false }: { anonymous?: boolean } = {},
) {
  return treaty<MainApp>(`${origin}${BFF_PREFIX}`, {
    headers: () =>
      typeof window === 'undefined' ? {} : { 'x-rezics-page-url': window.location.href },
    // A public reader without an eligible Agent must not send an authenticated
    // request with no actingSubject (Main rejects that ambiguous authority).
    fetch: { credentials: anonymous ? 'omit' : 'same-origin' },
  });
}
