import { NextRequest } from 'next/server';
import type { UiLocale } from '../../i18n/define.ts';
import { getTranslation } from '../../i18n/server.ts';
import { displayLanguages } from '../../i18n/display-languages.ts';
import { LOCALE_COOKIE, pathLocale, resolveLocale, withoutLocale } from '../../i18n/locale.ts';
import { readAddress, type ResolvedAddress } from './client.ts';
import { addressPath } from './path.ts';
import { decideAddress } from './redirect.ts';
import { readSpacePage, realmDiscovery } from './space-read.ts';
import { spaceDiscoveryHeaders } from '../space-access/discovery.tsx';
import { ACCESS_COOKIE, REFRESH_COOKIE, SESSION_KEY_COOKIE } from '../auth/cookies.ts';
import { currentSessionRecord } from '../auth/session-state.ts';
import { serviceOrigin } from '../api/origins.ts';
import { mainReadHeaders } from '../api/main-read.ts';
import { serverRead, withServerRequest } from '../api/server-read.ts';
import { zoneNonce } from '../zones/csp.ts';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Admission failures precede the app shell. Keep their HTTP status and a
 * complete, localized recovery document, including the exact attempted task.
 * The Worker entry executes in the RSC environment: pre-shell HTML must not
 * import react-dom/server, whose react-server export deliberately throws. */
export async function addressFailureResponse(url: URL, locale: UiLocale,
  status: 400 | 404 | 409 | 410 | 422 | 429 | 503, retryAfter?: string): Promise<Response> {
  const [{ data: t }, { data: page }] = await Promise.all([
    getTranslation('shell', [locale]), getTranslation('workPage', [locale]),
  ]);
  const missing = status === 404 || status === 410;
  const restart = status === 400 || status === 409;
  const task = new URL(url);
  if (restart) {
    task.searchParams.delete('after');
    const parents = task.searchParams.getAll('parent');
    if (parents.length !== 1 || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(parents[0]!))
      task.searchParams.delete('parent');
  }
  const title = missing ? t.notFoundTitle : t.errorTitle;
  const description = missing ? t.notFoundBody : status === 400 ? page.invalid :
    status === 409 ? page.moved : status === 422 ? page.budget : t.errorBody;
  const nonce = zoneNonce();
  const link = (href: string, label: string) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  // The same decorative Lucide search-x / triangle-alert paths, without a React import.
  const icon = missing
    ? '<path d="m13.5 8.5-5 5"></path><path d="m8.5 8.5 5 5"></path><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path>'
    : '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path>';
  const document = `<!DOCTYPE html><html lang="${escapeHtml(locale)}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · REZICS</title>
<style nonce="${nonce}">html{color-scheme:light dark;font:100%/1.6 system-ui}body{margin:0}main{max-width:42rem;margin:12vh auto;padding:1.5rem;overflow-wrap:anywhere}svg{width:2rem;height:2rem}h1{font-size:1.75rem}a{display:inline-block;margin:.5rem 1rem .5rem 0;text-underline-offset:.2em}a:focus-visible{outline:3px solid;outline-offset:4px}</style>
</head><body><main><div data-slot="empty-state"${missing ? '' : ' role="alert"'}>
<span><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p><div>
${missing ? '' : `<a data-retry href="${escapeHtml(task.pathname + task.search)}">${escapeHtml(restart ? page.firstPage : t.retry)}</a>`}
${link(`/${locale}/discover${url.searchParams.get('type') === 'lists' ? '?type=lists' : ''}`, t.searchWorks)}
${link(`/${locale}`, t.backHome)}
</div>${missing ? '' : `<p data-retry-pending role="status" hidden>${escapeHtml(t.loading)}</p>`}</div></main>
${missing ? '' : `<script nonce="${nonce}">
(() => {
  const retry = document.querySelector('[data-retry]');
  const pending = document.querySelector('[data-retry-pending]');
  retry.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    retry.setAttribute('aria-busy', 'true');
    pending.hidden = false;
  });
  window.addEventListener('pageshow', () => {
    retry.removeAttribute('aria-busy');
    pending.hidden = true;
  });
})();
</script>`}</body></html>`;
  return new Response(document, { status, headers: { 'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    ...(!missing && retryAfter ? { 'retry-after': retryAfter } : status === 429 || status === 503 ? { 'retry-after': '5' } : {}) } });
}

/** vinext normalizes trailing slashes before middleware. Resolve addressed
 * requests at the Worker entry first to prevent a 308 → 301 chain. */
export async function beforePathNormalization(
  request: Request,
  mainOrigin?: string,
): Promise<Response | null> {
  return withServerRequest(request, () => resolveBeforeNormalization(request, mainOrigin));
}

async function resolveBeforeNormalization(request: Request, mainOrigin?: string): Promise<Response | null> {
  const url = new URL(request.url);
  const path = addressPath(url.pathname);
  if (
    !['GET', 'HEAD'].includes(request.method) ||
    !url.pathname.endsWith('/') ||
    (!path && withoutLocale(url.pathname).replace(/\/+$/, '') !== '/r')
  )
    return null;
  const incoming = new NextRequest(request);
  // Proxy owns token rotation and its cookies. Do not decide a private address
  // anonymously while that signed-in request still needs its refresh.
  if ((path?.lookup.scope === 'work' || path?.lookup.scope === 'resource') &&
    incoming.cookies.get(REFRESH_COOKIE)?.value && !incoming.cookies.get(ACCESS_COOKIE)?.value) return null;
  const locale =
    pathLocale(url.pathname) ??
    resolveLocale(
      incoming.cookies.get(LOCALE_COOKIE)?.value,
      request.headers.get('accept-language'),
    );
  const languages = displayLanguages({ pageUrl: request.url, uiLocale: locale }).join(',');
  let viewer: { token: string; actingSubject: string } | undefined;
  if ((path?.lookup.scope === 'work' || path?.lookup.scope === 'resource') && currentSessionRecord(incoming.cookies)) {
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
      return addressFailureResponse(url, locale, 503);
    }
  }
  let spaceAddress: ResolvedAddress | undefined;
  const decision = await decideAddress(url, locale, async (lookup) => {
    const read = await readAddress(
      lookup,
      languages,
      mainOrigin,
      request.headers,
      lookup.scope === 'work' || lookup.scope === 'resource' ? viewer : undefined,
      // A cached public Work must not disclose its canonical name after becoming private.
      lookup.scope === 'work' || lookup.scope === 'resource',
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
    return addressFailureResponse(url, locale, decision.status, decision.retryAfter);
  return null;
}
