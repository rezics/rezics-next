import { NextRequest } from 'next/server';
import { displayLanguages } from '../../i18n/display-languages.ts';
import { LOCALE_COOKIE, pathLocale, resolveLocale, withoutLocale } from '../../i18n/locale.ts';
import { readAddress } from './client.ts';
import { addressPath } from './path.ts';
import { decideAddress } from './redirect.ts';

/** vinext normalizes trailing slashes before middleware. Resolve addressed
 * requests at the Worker entry first to prevent a 308 → 301 chain. */
export async function beforePathNormalization(request: Request, mainOrigin?: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method) || !url.pathname.endsWith('/')
    || !addressPath(url.pathname) && withoutLocale(url.pathname).replace(/\/+$/, '') !== '/r') return null;
  const incoming = new NextRequest(request);
  const locale = pathLocale(url.pathname) ?? resolveLocale(incoming.cookies.get(LOCALE_COOKIE)?.value,
    request.headers.get('accept-language'));
  const decision = await decideAddress(url, locale, lookup => readAddress(lookup,
    displayLanguages({ pageUrl: request.url, uiLocale: locale }).join(','), mainOrigin));
  if (decision.kind === 'redirect') return new Response(null, { status: 301,
    headers: { location: new URL(decision.location, request.url).toString() } });
  if (decision.kind === 'error') return new Response(null, { status: decision.status,
    headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  return null;
}
