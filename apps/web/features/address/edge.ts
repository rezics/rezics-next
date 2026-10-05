import { NextRequest } from 'next/server';
import { displayLanguages } from '../../i18n/display-languages.ts';
import { LOCALE_COOKIE, pathLocale, resolveLocale, withoutLocale } from '../../i18n/locale.ts';
import { readAddress, type ResolvedAddress } from './client.ts';
import { addressPath } from './path.ts';
import { decideAddress } from './redirect.ts';
import { readSpacePage, realmDiscovery } from './space-read.ts';
import { spaceDiscoveryHeaders } from '../space-access/discovery.tsx';
import { ACCESS_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { currentSessionRecord } from '../auth/session-state.ts';
import { serviceOrigin } from '../api/origins.ts';
import { mainReadHeaders } from '../api/main-read.ts';
import { serverRead } from '../api/server-read.ts';

/** vinext normalizes trailing slashes before middleware. Resolve addressed
 * requests at the Worker entry first to prevent a 308 → 301 chain. */
export async function beforePathNormalization(
  request: Request,
  mainOrigin?: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = addressPath(url.pathname);
  if (
    !['GET', 'HEAD'].includes(request.method) ||
    !url.pathname.endsWith('/') ||
    (!path && withoutLocale(url.pathname).replace(/\/+$/, '') !== '/r')
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
  let viewer: { token: string; actingSubject: string } | undefined;
  if (path?.lookup.scope === 'work' && currentSessionRecord(incoming.cookies)) {
    const token = incoming.cookies.get(ACCESS_COOKIE)!.value;
    try {
      const response = await serverRead(
        `${mainOrigin ?? serviceOrigin('MAIN_ORIGIN')}/v1/me/session-agent`,
        {
          headers: await mainReadHeaders(
            {
              authorization: `Bearer ${token}`,
              'x-session-key': incoming.cookies.get(SESSION_KEY_COOKIE)?.value ?? '',
            },
            request.headers,
          ),
        },
      );
      if (!response.ok) throw new Error('Session Agent is unavailable');
      const state = (await response.json()) as {
        sessionAgent?: { eligible?: boolean; actingSubject?: string };
      };
      if (state.sessionAgent?.eligible && state.sessionAgent.actingSubject)
        viewer = { token, actingSubject: state.sessionAgent.actingSubject };
    } catch {
      return new Response(null, {
        status: 503,
        headers: {
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
          'retry-after': '5',
        },
      });
    }
  }
  let spaceAddress: ResolvedAddress | undefined;
  const decision = await decideAddress(url, locale, async (lookup) => {
    const read = await readAddress(
      lookup,
      languages,
      mainOrigin,
      request.headers,
      lookup.scope === 'work' ? viewer : undefined,
    );
    if (lookup.scope === 'space' && read.kind === 'resolved') spaceAddress = read.data;
    return read;
  });
  let discoveryHeaders: Record<string, string> = {};
  if (decision.kind === 'redirect' && spaceAddress) {
    const page = await readSpacePage(spaceAddress.key, languages, {
      address: spaceAddress,
      origin: mainOrigin,
      incoming: request.headers,
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
        ...(viewer ? { 'cache-control': 'private, no-store' } : {}),
        ...discoveryHeaders,
      },
    });
  if (decision.kind === 'error')
    return new Response(null, {
      status: decision.status,
      headers: {
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
        ...(decision.status === 503 ? { 'retry-after': '5' } : {}),
        ...(decision.retryAfter ? { 'retry-after': decision.retryAfter } : {}),
        ...(path?.lookup.scope === 'space' ? { 'referrer-policy': 'no-referrer' } : {}),
      },
    });
  return null;
}
