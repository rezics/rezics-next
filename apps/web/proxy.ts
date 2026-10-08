import { type NextRequest, NextResponse } from 'next/server';
import {
  ACCESS_COOKIE,
  AGENT_COOKIE,
  cookieOptions,
  isSessionKey,
  REFRESH_COOKIE,
  rewriteCookieHeader,
  SESSION_COOKIES,
  SESSION_KEY_COOKIE,
  REFRESH_LIFETIME_SECONDS,
} from './features/auth/cookies.ts';
import { accountClient } from './features/auth/client.ts';
import { refreshSession } from './features/auth/refresh.ts';
import { type SessionCookie, sessionCookies } from './features/auth/session-state.ts';
import {
  isPublicPagePath,
  isReportPath,
  LOCALE_COOKIE,
  pathLocale,
  resolveLocale,
} from './i18n/locale.ts';
import { isZonePage, ZONE_NONCE_HEADER, zoneCsp, zoneNonce } from './features/zones/csp.ts';
import { ADDRESS_HEADER, readAddress, type ResolvedAddress } from './features/address/client.ts';
import { addressPath } from './features/address/path.ts';
import { decideAddress } from './features/address/redirect.ts';
import { studioSegmentIri } from './features/studio/agent.ts';
import { displayLanguages } from './i18n/display-languages.ts';
import { privateDiscovery, readSpacePage, realmDiscovery } from './features/address/space-read.ts';
import { spaceDiscoveryHeaders } from './features/space-access/discovery.tsx';
import { serviceOrigin } from './features/api/origins.ts';
import { mainReadHeaders } from './features/api/main-read.ts';
import { serverRead } from './features/api/server-read.ts';
import { SERVER_DEADLINE_HEADER, SERVER_READ_LIMITS } from './features/api/server-fetch.ts';
import { mainPosition, parsePosition } from './features/wiki/position.ts';
import { WORK_MISSING_HEADER } from './features/work-page/admission.ts';

// Refreshes the session before any page, Server Action, route handler or BFF
// call reads it, so each request refreshes at most once and nothing
// downstream handles expiry. The rewritten Cookie header carries the new
// tokens to that code; Set-Cookie carries them to the browser.

/**
 * The Agent a recipe-editor link names, when the segment is an address.
 * A handle is resolved from the Agents this account may create as. Main still
 * admits the result; a segment this account cannot act for is not replaced here.
 */
async function linkedRecipeSubject(url: URL, token: string, incoming: Headers, deadlineAt: number): Promise<string | null> {
  if (!/\/w\/[^/]+\/edit\/recipe\/?$/.test(url.pathname)) return null;
  const segment = url.searchParams.get('agent');
  if (!segment) return null;
  const direct = studioSegmentIri(segment);
  if (direct) return direct;
  let value = segment;
  try { value = decodeURIComponent(segment); } catch { return null; }
  if (!value.startsWith('@')) return null;
  const handle = value.slice(1).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(handle)) return null;
  try {
    const response = await serverRead(`${serviceOrigin('MAIN_ORIGIN')}/v1/me/acting-contexts?task=work.create`, {
      headers: await mainReadHeaders({ authorization: `Bearer ${token}` }, incoming), cache: 'no-store' },
      { deadlineAt, timeoutMs: SERVER_READ_LIMITS.metadata });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json() as { contexts?: readonly { actingSubject?: unknown; handle?: unknown }[];
      directContexts?: readonly { actingSubject?: unknown; handle?: unknown }[] };
    const match = [...(body.contexts ?? []), ...(body.directContexts ?? [])].find(item =>
      typeof item.handle === 'string' && item.handle.toLowerCase() === handle && typeof item.actingSubject === 'string');
    return typeof match?.actingSubject === 'string' ? match.actingSubject : null;
  } catch { return null; }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const transfer = request.nextUrl.pathname.startsWith('/api/main/v1/media/');
  const deadlineAt =
    Date.now() + (transfer ? SERVER_READ_LIMITS.transfer : SERVER_READ_LIMITS.page);
  const incoming = new Headers(request.headers);
  incoming.delete(WORK_MISSING_HEADER);
  incoming.set(SERVER_DEADLINE_HEADER, String(deadlineAt));
  const pathname = request.nextUrl.pathname;
  const locale =
    pathLocale(pathname) ??
    resolveLocale(
      request.cookies.get(LOCALE_COOKIE)?.value,
      request.headers.get('accept-language'),
    );
  const client = accountClient();
  const outcome = await refreshSession(request.cookies, client ? { ...client, deadlineAt } : null);
  const signedIn = Boolean(
    request.cookies.get(ACCESS_COOKIE)?.value || request.cookies.get(REFRESH_COOKIE)?.value,
  );
  const sessionKey =
    outcome.kind !== 'ended' &&
    signedIn &&
    !isSessionKey(request.cookies.get(SESSION_KEY_COOKIE)?.value)
      ? crypto.randomUUID()
      : null;
  const renewedKey =
    sessionKey ??
    (outcome.kind === 'refreshed' ? request.cookies.get(SESSION_KEY_COOKIE)?.value : null);
  const legacyAgent = outcome.kind !== 'ended' && Boolean(request.cookies.get(AGENT_COOKIE)?.value);
  const cookies: SessionCookie[] =
    outcome.kind === 'refreshed'
      ? sessionCookies(request.url, outcome.tokens, outcome.user)
      : outcome.kind === 'ended'
        ? SESSION_COOKIES.map((name) => ({
            name,
            value: '',
            options: cookieOptions(request.url, 0),
          }))
        : [];
  if (renewedKey)
    cookies.push({
      name: SESSION_KEY_COOKIE,
      value: renewedKey,
      options: cookieOptions(request.url, REFRESH_LIFETIME_SECONDS),
    });
  if (legacyAgent)
    cookies.push({ name: AGENT_COOKIE, value: '', options: cookieOptions(request.url, 0) });
  const finish = (response: NextResponse) => {
    for (const cookie of cookies) response.cookies.set(cookie.name, cookie.value, cookie.options);
    return response;
  };
  const access = cookies.find((cookie) => cookie.name === ACCESS_COOKIE);
  const token = access ? access.value || undefined : request.cookies.get(ACCESS_COOKIE)?.value;
  let resourceViewer: { token: string; actingSubject: string } | undefined;
  const addressScope = addressPath(pathname)?.lookup.scope;
  if ((addressScope === 'resource' || addressScope === 'work') && token) {
    try {
      const response = await serverRead(
        `${serviceOrigin('MAIN_ORIGIN')}/v1/me/session-agent`,
        {
          headers: await mainReadHeaders(
            {
              authorization: `Bearer ${token}`,
              'x-session-key': renewedKey ?? request.cookies.get(SESSION_KEY_COOKIE)?.value ?? '',
            },
            incoming,
          ),
          cache: 'no-store',
        },
        { deadlineAt, timeoutMs: SERVER_READ_LIMITS.metadata },
      );
      if (!response.ok)
        return finish(
          new NextResponse(null, {
            status: 503,
            headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'retry-after': '5' },
          }),
        );
      const state = (await response.json()) as {
        sessionAgent?: { eligible?: boolean; actingSubject?: string };
      };
      if (state.sessionAgent?.eligible && state.sessionAgent.actingSubject)
        resourceViewer = { token, actingSubject: state.sessionAgent.actingSubject };
    } catch {
      return finish(
        new NextResponse(null, {
          status: 503,
          headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'retry-after': '5' },
        }),
      );
    }
  }
  // A Studio recipe link names its Agent. The owner read uses that Agent, and Main refuses one this account cannot act for.
  if (token) {
    const linked = await linkedRecipeSubject(request.nextUrl, token, incoming, deadlineAt);
    if (linked) resourceViewer = { token, actingSubject: linked };
  }
  const pageRequest = request.method === 'GET' || request.method === 'HEAD';
  let spaceAddress: ResolvedAddress | undefined;
  let resourceAddress: ResolvedAddress | undefined;
  let workAddress: ResolvedAddress | undefined;
  let addressed = pageRequest
    ? await decideAddress(new URL(request.url), locale, async (lookup) => {
        const read = await readAddress(
          lookup,
          displayLanguages({ pageUrl: request.url, uiLocale: locale }).join(','),
          undefined,
          incoming,
          lookup.scope === 'resource' || lookup.scope === 'work' ? resourceViewer : undefined,
        );
        if (lookup.scope === 'space' && read.kind === 'resolved') spaceAddress = read.data;
        if (lookup.scope === 'resource' && read.kind === 'resolved') resourceAddress = read.data;
        if (lookup.scope === 'work' && read.kind === 'resolved') workAddress = read.data;
        return read;
      })
    : { kind: 'pass' as const };
  const path = pageRequest ? addressPath(pathname) : null;
  // An address hit can be cached; the owner checks live reading authority before any shell or metadata streams.
  // Never call the owner after an address miss: enumeration is charged by that single resolver request.
  if (path?.lookup.scope === 'resource' && resourceAddress && addressed.kind !== 'error') {
    const query = new URLSearchParams(
      resourceViewer ? { actingSubject: resourceViewer.actingSubject } : {},
    );
    const positions = request.nextUrl.searchParams.getAll('position');
    const position = mainPosition(
      parsePosition({ position: positions.length === 1 ? positions[0] : undefined }),
    );
    if (position) query.set('position', position);
    try {
      const response = await serverRead(
        `${serviceOrigin('MAIN_ORIGIN')}/v1/resources/${resourceAddress.holder.slice(-36)}/page?${query}`,
        {
          headers: await mainReadHeaders(
            {
              'accept-language': locale,
              ...(resourceViewer ? { authorization: `Bearer ${resourceViewer.token}` } : {}),
            },
            incoming,
          ),
          cache: 'no-store',
        },
        { deadlineAt, timeoutMs: SERVER_READ_LIMITS.metadata },
      );
      const denied = response.status === 404 || response.status === 403;
      if (denied) {
        // A formerly public cached hit may have become private. Revalidate through the charged resolver once.
        const current = await readAddress(
          path.lookup,
          displayLanguages({ pageUrl: request.url, uiLocale: locale }).join(','),
          undefined,
          incoming,
          resourceViewer,
          true,
        );
        addressed =
          current.kind === 'unavailable'
            ? {
                kind: 'error',
                status: current.status ?? 503,
                ...(current.retryAfter ? { retryAfter: current.retryAfter } : {}),
              }
            : current.kind === 'retired'
              ? { kind: 'error', status: 410 }
              : { kind: 'error', status: 404 };
      } else if (!response.ok) addressed = { kind: 'error', status: 503 };
      else {
        const page = (await response.json()) as { summary?: { status?: string } };
        if (page.summary?.status !== 'available') addressed = { kind: 'error', status: 404 };
      }
      if (!response.bodyUsed) await response.body?.cancel();
    } catch {
      addressed = { kind: 'error', status: 503 };
    }
  }
  if (path?.lookup.scope === 'work' && addressed.kind !== 'error') {
    // Editors skip canonical redirects, but their pages also need a visible Work.
    if (!workAddress) {
      const read = await readAddress(path.lookup,
        displayLanguages({ pageUrl: request.url, uiLocale: locale }).join(','), undefined, incoming, resourceViewer);
      if (read.kind === 'resolved') workAddress = read.data;
      else addressed = { kind: 'error', status: read.kind === 'missing' ? 404 : read.kind === 'retired' ? 410 : read.status ?? 503,
        ...(read.kind === 'unavailable' && read.retryAfter ? { retryAfter: read.retryAfter } : {}) };
    }
    if (workAddress && addressed.kind !== 'error') {
      // A cached public address cannot admit a Work that has since become private.
      const query = new URLSearchParams(resourceViewer ? { actingSubject: resourceViewer.actingSubject } : {});
      // Former chapter addresses resolve to a Post's reader place, not a Work header.
      const owner = addressPath(workAddress.canonical.prefix)?.lookup.scope === 'work' ? 'posts' : 'works';
      const url = `${serviceOrigin('MAIN_ORIGIN')}/v1/${owner}/${workAddress.holder.slice(-36)}?${query}`;
      try {
        const read = async () => serverRead(url, {
          headers: await mainReadHeaders({ 'accept-language': locale,
            ...(resourceViewer ? { authorization: `Bearer ${resourceViewer.token}` } : {}) }, incoming),
          cache: 'no-store',
        }, { deadlineAt, timeoutMs: SERVER_READ_LIMITS.metadata });
        let response = await read();
        if (response.status === 409) {
          await response.body?.cancel();
          response = await read();
        }
        if (response.status === 404 || response.status === 403 || response.status === 410)
          addressed = { kind: 'error', status: 404 };
        else if (!response.ok) addressed = { kind: 'error', status: 503 };
        await response.body?.cancel();
      } catch {
        addressed = { kind: 'error', status: 503 };
      }
    }
  }
  // Decide status before loading can stream, then render the localized Work boundary.
  const missingWork = path?.lookup.scope === 'work' && addressed.kind === 'error' && addressed.status === 404;
  if (missingWork)
    addressed = { kind: 'pass' };
  let discoveryHeaders: Record<string, string> = {};
  // Resolve denied Space reads through Main's limited landing page. A missing
  // resolver answer alone neither admits a page nor invents its capabilities.
  if (path?.lookup.scope === 'space' && (addressed.kind !== 'error' || addressed.status === 404)) {
    const token = request.cookies.get(ACCESS_COOKIE)?.value;
    let actingSubject: string | undefined;
    if (token && addressed.kind === 'error') {
      try {
        const response = await serverRead(
          `${serviceOrigin('MAIN_ORIGIN')}/v1/me/session-agent`,
          {
            headers: await mainReadHeaders(
              {
                authorization: `Bearer ${token}`,
                'x-session-key': request.cookies.get(SESSION_KEY_COOKIE)?.value ?? '',
              },
              incoming,
            ),
            cache: 'no-store',
          },
          { deadlineAt, timeoutMs: SERVER_READ_LIMITS.metadata },
        );
        if (response.ok) {
          const session = (await response.json()) as {
            sessionAgent?: { eligible?: boolean; actingSubject?: string };
          };
          if (session.sessionAgent?.eligible) actingSubject = session.sessionAgent.actingSubject;
        }
      } catch {
        /* Main's anonymous landing read remains independently available. */
      }
    }
    const page = await readSpacePage(
      path.lookup.key,
      displayLanguages({ pageUrl: request.url, uiLocale: locale }).join(','),
      { address: spaceAddress, token, actingSubject, incoming },
    );
    if (page.kind === 'join' || page.kind === 'realm') {
      const discovery =
        page.kind === 'join' ? privateDiscovery(page.page.discovery) : realmDiscovery(page.header);
      discoveryHeaders = discovery ? spaceDiscoveryHeaders(discovery) : {};
      if (addressed.kind === 'error') addressed = { kind: 'pass' };
    } else if (page.kind === 'unavailable') addressed = { kind: 'error', status: 503 };
  }
  if (addressed.kind === 'redirect') {
    const response = NextResponse.redirect(
      new URL(addressed.location, request.url),
      addressed.status,
    );
    if (addressScope === 'work' && resourceViewer)
      response.headers.set('cache-control', 'private, no-store');
    for (const [name, value] of Object.entries(discoveryHeaders)) response.headers.set(name, value);
    return finish(response);
  }
  if (addressed.kind === 'error')
    return finish(
      new NextResponse(null, {
        status: addressed.status,
        headers: {
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
          ...(addressed.status === 503 ? { 'retry-after': '5' } : {}),
          ...(addressed.retryAfter ? { 'retry-after': addressed.retryAfter } : {}),
          ...(path?.lookup.scope === 'space' ? { 'referrer-policy': 'no-referrer' } : {}),
        },
      }),
    );
  if (
    (isPublicPagePath(pathname) || addressPath(pathname)) &&
    !pathLocale(pathname) &&
    pageRequest
  ) {
    const destination = request.nextUrl.clone();
    destination.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
    return finish(NextResponse.redirect(destination));
  }
  const headers = incoming;
  if (missingWork) headers.set(WORK_MISSING_HEADER, '1');
  headers.delete(ADDRESS_HEADER);
  // HTTP header values are bytes; native-script names need an ASCII envelope.
  if ('data' in addressed && addressed.data)
    headers.set(ADDRESS_HEADER, encodeURIComponent(JSON.stringify(addressed.data)));
  if (pathLocale(pathname))
    headers.set('x-rezics-page-url', request.nextUrl.origin + pathname + request.nextUrl.search);
  else headers.delete('x-rezics-page-url');
  headers.set(
    'cookie',
    rewriteCookieHeader(
      request.headers.get('cookie'),
      Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value || null])),
    ),
  );
  const nonce = isZonePage(pathname) ? zoneNonce() : null;
  const policy = nonce && zoneCsp(nonce, process.env.NODE_ENV === 'development');
  headers.delete(ZONE_NONCE_HEADER);
  if (nonce && policy) {
    headers.set('content-security-policy', policy);
    headers.set(ZONE_NONCE_HEADER, nonce);
  }
  const response = NextResponse.next({ request: { headers }, ...(missingWork ? { status: 404 } : {}) });
  if (missingWork) {
    response.headers.set('cache-control', 'no-store');
    response.headers.set('x-robots-tag', 'noindex');
  }
  for (const [name, value] of Object.entries(discoveryHeaders)) response.headers.set(name, value);
  if (policy) response.headers.set('content-security-policy', policy);
  // A case's private page keeps its credential in the address; no request it makes may carry that address on.
  if (isReportPath(pathname)) response.headers.set('referrer-policy', 'no-referrer');
  return finish(response);
}

export const config = {
  // Static files and the routes that manage tokens themselves.
  matcher: ['/((?!assets/|_next/|favicon\\.ico|favicon\\.svg|auth/callback|sign-out).*)'],
};
