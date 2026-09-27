import { webConfig } from '../config/env.ts';

export function serviceOrigin(name: 'MAIN_ORIGIN' | 'ACCOUNT_ORIGIN'): string {
  const url = new URL(webConfig()[name]);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return url.origin;
}

/** A write the session cookie may authorize: from this origin, or from a
 * non-browser client that sends neither Origin nor Fetch Metadata. */
export function sameOriginWrite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  return !origin || origin === new URL(request.url).origin;
}
