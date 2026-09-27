import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';

/** Mount point of the BFF proxy. Main's paths continue unchanged after it. */
export const BFF_PREFIX = '/api/main';

/** Browser Eden client for Main through the BFF: the same `MainApp` type as
 * `mainApi()`, with the session cookie standing in for the bearer token. Send
 * an `Idempotency-Key` header on commands exactly as Main documents it. */
export function browserMainApi(origin: string = window.location.origin) {
  return treaty<MainApp>(`${origin}${BFF_PREFIX}`, { fetch: { credentials: 'same-origin' } });
}
