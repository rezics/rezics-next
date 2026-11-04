import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { locales, localizeUrl, type Locale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { cookie } from '../../session/cookies.ts';
import {
  DEPENDENCY_UNAVAILABLE_CODE,
  LOGIN_RETURN_COOKIE,
  recoveryReturnLocale,
  safeRecoveryReturn,
} from '../../session/unavailable';
import { securityHeaders } from '../../security/headers.ts';
import { createNonce } from '../../security/nonce.ts';
import { preferencesBootstrap } from '../preferences-script';
import { routeRetry, safeRetryAfter } from '../error-state';
import { DependencyUnavailablePage } from './page';

type DocumentFailureIntent = 'sign-in' | 'callback' | 'command';
const formRoutes = new Set(['/checkout', '/library/entry', ...locales.map((locale) => `/${locale}/settings`)]);

export type DocumentRecoveryOptions = {
  fallbackLocale: (request: Request) => Locale | Promise<Locale>;
  stylesheet: () => string | Promise<string>;
  nonce?: (request: Request) => string;
  issuer?: string;
  development?: boolean;
};

function isHtmlAccept(request: Request): boolean {
  return (request.headers.get('accept') ?? '').split(',').some((entry) => {
    const [type, ...parameters] = entry.trim().toLowerCase().split(';');
    if (type !== 'text/html' && type !== 'application/xhtml+xml') return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith('q='));
    return quality === undefined || Number(quality.trim().slice(2)) > 0;
  });
}

function isDocumentNavigation(request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode');
  const destination = request.headers.get('sec-fetch-dest');
  if (mode !== null || destination !== null) return mode === 'navigate' && destination === 'document';
  return isHtmlAccept(request);
}

function formDocumentNavigation(request: Request): boolean {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded' && contentType !== 'multipart/form-data') return false;
  return isDocumentNavigation(request);
}

export function documentFailureIntent(request: Request): DocumentFailureIntent | undefined {
  const { pathname } = new URL(request.url);
  if ((request.method === 'GET' || request.method === 'HEAD') && (pathname === '/auth/sign-in' || pathname === '/auth/callback')) {
    if (!isDocumentNavigation(request)) return undefined;
    return pathname === '/auth/sign-in' ? 'sign-in' : 'callback';
  }
  if (request.method !== 'POST' || !formDocumentNavigation(request)) return undefined;
  return formRoutes.has(pathname) ? 'command' : undefined;
}

async function dependencyProblem(response: Response): Promise<{ retryable: boolean } | undefined> {
  if (response.status < 400 || response.status > 599) return undefined;
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/problem+json')
    return undefined;
  try {
    const body = (await response.clone().json()) as {
      type?: unknown;
      code?: unknown;
      status?: unknown;
      retryable?: unknown;
    };
    const valid =
      body.type === `https://rezics.com/problems/${DEPENDENCY_UNAVAILABLE_CODE}` &&
      body.code === DEPENDENCY_UNAVAILABLE_CODE &&
      body.status === response.status;
    return valid ? { retryable: body.retryable !== false } : undefined;
  } catch {
    return undefined;
  }
}

function localeFromPath(request: Request): Locale | undefined {
  const candidate = new URL(request.url).pathname.split('/')[1];
  return locales.find((locale) => locale === candidate);
}

function recoveryPath(request: Request, intent: DocumentFailureIntent): string | undefined {
  const url = new URL(request.url);
  if (intent === 'sign-in') {
    const values = url.searchParams.getAll('return_to');
    return values.length === 1 ? safeRecoveryReturn(values[0], url.origin) : undefined;
  }
  if (intent === 'callback') return safeRecoveryReturn(cookie(request, LOGIN_RETURN_COOKIE), url.origin);
  return safeRecoveryReturn(request.headers.get('referer'), url.origin);
}

function localizedPath(path: string | undefined, locale: Locale, origin: string): string {
  const local = path ?? '/';
  return localizeUrl(new URL(local, origin), { locale }).pathname;
}

function recoveryIssuerOrigin(issuer: string | undefined): string {
  if (!issuer) return '';
  try {
    return new URL(issuer).origin;
  } catch {
    return '';
  }
}

function documentMarkup(
  locale: Locale,
  stylesheet: string,
  nonce: string,
  intent: DocumentFailureIntent,
  retryHref: string | undefined,
  returnHref: string | undefined,
  retryDisabled: boolean,
  retryDelay: number,
  recovery: string | undefined,
): string {
  const heading = m.dependency_unavailable_heading({}, { locale });
  return `<!doctype html>${renderToStaticMarkup(
    createElement(
      'html',
      { lang: locale, suppressHydrationWarning: true },
      createElement(
        'head',
        null,
        createElement('meta', { charSet: 'utf-8' }),
        createElement('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1' }),
        createElement('meta', { name: 'robots', content: 'noindex' }),
        createElement('meta', { property: 'csp-nonce', content: nonce }),
        createElement('title', null, heading),
        createElement('link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }),
        createElement('link', { rel: 'stylesheet', href: stylesheet }),
        createElement('script', {
          nonce,
          'data-preferences': '',
          dangerouslySetInnerHTML: { __html: preferencesBootstrap },
        }),
        retryDelay > 0
          ? createElement('script', {
              nonce,
              dangerouslySetInnerHTML: {
                __html: `(() => { const link = document.querySelector('[data-dependency-retry]'); if (!link) return; let ready = false; link.addEventListener('click', (event) => { if (!ready) event.preventDefault(); }); window.setTimeout(() => { ready = true; link.hidden = false; link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex'); }, ${retryDelay * 1000}); })()`,
              },
            })
          : null,
      ),
      createElement(
        'body',
        null,
        createElement(
          'main',
          { id: 'main-content', tabIndex: -1, className: 'mx-auto w-full max-w-6xl px-4 py-6 md:px-8' },
          createElement(DependencyUnavailablePage, {
            locale,
            ...(retryHref ? { retryHref } : {}),
            ...(returnHref ? { returnHref } : {}),
            commandMayHaveCompleted: intent === 'command',
            retryDisabled,
            ...(recovery ? { recovery } : {}),
          }),
        ),
      ),
    ),
  )}`;
}

/** Convert only known visitor document failures. RPC, media, and command fetches retain their machine response. */
export async function adaptUnavailableDocument(
  request: Request,
  response: Response,
  options: DocumentRecoveryOptions,
): Promise<Response> {
  const intent = documentFailureIntent(request);
  if (!intent) return response;
  const failure = await dependencyProblem(response);
  if (!failure) return response;

  const url = new URL(request.url);
  const returnPath = recoveryPath(request, intent);
  const locale = recoveryReturnLocale(returnPath) ?? localeFromPath(request) ?? (await options.fallbackLocale(request));
  const homePath = localizedPath(undefined, locale, url.origin);
  const localReturn = returnPath ? localizedPath(returnPath, locale, url.origin) : undefined;
  const returnHref = localReturn === homePath ? undefined : localReturn;
  const returnTarget = localReturn ?? homePath;
  const headers = new Headers(response.headers);
  const retryAfter = safeRetryAfter(headers);
  const policy = routeRetry({
    status: response.status,
    retryable: failure.retryable,
    ...(retryAfter ? { headers: { 'retry-after': retryAfter } } : {}),
  });
  const retryHref =
    intent !== 'command' && policy.allowed && !policy.deferred
      ? `/auth/sign-in?return_to=${encodeURIComponent(returnTarget)}`
      : undefined;
  const retryDelay = retryHref ? policy.delay : 0;
  const recovery = !policy.allowed
    ? m.route_retry_unavailable({}, { locale })
    : policy.deferred
      ? m.route_retry_later({}, { locale })
      : policy.delay > 0
        ? m.route_retry_after({ seconds: policy.delay }, { locale })
        : undefined;
  const nonce = options.nonce?.(request) ?? createNonce(request);
  const [stylesheet, csp] = await Promise.all([
    options.stylesheet(),
    Promise.resolve(securityHeaders(request, nonce, recoveryIssuerOrigin(options.issuer), options.development)),
  ]);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('content-md5');
  headers.delete('retry-after');
  if (retryAfter) headers.set('retry-after', retryAfter);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('content-language', locale);
  headers.set('cache-control', 'private, no-store');
  headers.set('x-robots-tag', 'noindex');
  const vary = new Set((headers.get('vary') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  vary.add('Cookie');
  vary.add('Accept-Language');
  headers.set('vary', [...vary].join(', '));
  csp.forEach((value, name) => headers.set(name, value));
  headers.set('x-robots-tag', 'noindex');

  const body = request.method === 'HEAD' ? null : documentMarkup(
    locale,
    stylesheet,
    nonce,
    intent,
    retryHref,
    returnHref,
    retryDelay > 0,
    retryDelay,
    recovery,
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
