import { pathLocale, withoutLocale } from '../../i18n/locale.ts';

// Zone pages may run an official Zone package: reviewed first-party code, but
// code that runs with the reader's session. Each response carries a fresh
// nonce and a strict script policy, so only scripts the page itself emitted
// (vinext reads the nonce from the request's policy header) can run.

/** The request header that hands the nonce to Server Components. */
export const ZONE_NONCE_HEADER = 'x-rezics-nonce';

/** `/{locale}/r/{realm}` and its tabs. */
export function isZonePage(pathname: string): boolean {
  return pathLocale(pathname) !== null && /^\/z\/[^/]+(?:\/|$)/.test(withoutLocale(pathname));
}

export function zoneNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
}

/**
 * The policy for one response. React's development build reconstructs server
 * call stacks with eval, so development alone adds `'unsafe-eval'`.
 */
export function zoneCsp(nonce: string, development = false): string {
  return [`script-src 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`, "object-src 'none'",
    "base-uri 'none'", "frame-ancestors 'none'"].join('; ');
}
