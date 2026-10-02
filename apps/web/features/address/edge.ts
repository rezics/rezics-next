import { NextRequest } from 'next/server';
import { displayLanguages } from '../../i18n/display-languages.ts';
import { LOCALE_COOKIE, pathLocale, resolveLocale, withoutLocale } from '../../i18n/locale.ts';
import { readAddress, type ResolvedAddress } from './client.ts';
import { addressPath } from './path.ts';
import { decideAddress } from './redirect.ts';
import { readSpacePage, realmDiscovery } from './space-read.ts';
import { spaceDiscoveryHeaders } from '../space-access/discovery.tsx';

/** vinext normalizes trailing slashes before middleware. Resolve addressed
 * requests at the Worker entry first to prevent a 308 → 301 chain. */
export async function beforePathNormalization(
  request: Request,
  mainOrigin?: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    !['GET', 'HEAD'].includes(request.method) ||
    !url.pathname.endsWith('/') ||
    (!addressPath(url.pathname) && withoutLocale(url.pathname).replace(/\/+$/, '') !== '/r')
  )
    return null;
  const incoming = new NextRequest(request);
  const locale =
    pathLocale(url.pathname) ??
    resolveLocale(
      incoming.cookies.get(LOCALE_COOKIE)?.value,
      request.headers.get('accept-language'),
    );
  const languages = displayLanguages({ pageUrl: request.url, uiLocale: locale }).join(',');
  let spaceAddress: ResolvedAddress | undefined;
  const decision = await decideAddress(url, locale, async (lookup) => {
    const read = await readAddress(lookup, languages, mainOrigin);
    if (lookup.scope === 'space' && read.kind === 'resolved') spaceAddress = read.data;
    return read;
  });
  let discoveryHeaders: Record<string, string> = {};
  if (decision.kind === 'redirect' && spaceAddress) {
    const page = await readSpacePage(spaceAddress.key, languages, {
      address: spaceAddress,
      origin: mainOrigin,
    });
    if (page.kind === 'realm') {
      const discovery = realmDiscovery(page.header);
      if (discovery) discoveryHeaders = spaceDiscoveryHeaders(discovery);
    }
  }
  if (decision.kind === 'redirect')
    return new Response(null, {
      status: 301,
      headers: {
        location: new URL(decision.location, request.url).toString(),
        ...discoveryHeaders,
      },
    });
  if (decision.kind === 'error')
    return new Response(null, {
      status: decision.status,
      headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
    });
  return null;
}
