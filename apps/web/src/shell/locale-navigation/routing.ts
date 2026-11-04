import { deLocalizeHref, localizeHref, locales } from '../../paraglide/runtime.js';

export type Locale = (typeof locales)[number];

export type LocaleNavigationLocation = Readonly<{
  pathname: string;
  searchStr: string;
  hash: string;
  locale: Locale;
  visitKey: string;
  supported: boolean;
}>;

export type LocaleDestination = Readonly<{
  locale: Locale;
  href: string;
  pathname: string;
  searchStr: string;
  hash: string;
  kind: 'page' | 'home';
}>;

const origin = 'https://locale.rezics.invalid';
const oidcParameters = new Set([
  'client_id',
  'code',
  'code_challenge',
  'code_challenge_method',
  'code_verifier',
  'id_token_hint',
  'iss',
  'issuer',
  'issuer_uri',
  'nonce',
  'post_logout_redirect_uri',
  'redirect_uri',
  'request',
  'request_uri',
  'response_mode',
  'response_type',
  'scope',
  'state',
]);
const credentialParameters = new Set([
  'access_token',
  'authorization',
  'download_token',
  'expires',
  'id_token',
  'key-pair-id',
  'policy',
  'refresh_token',
  'session',
  'session_token',
  'sig',
  'signature',
  'token',
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-security-token',
  'x-amz-signature',
  'x-goog-algorithm',
  'x-goog-credential',
  'x-goog-date',
  'x-goog-expires',
  'x-goog-signedheaders',
  'x-goog-signature',
  'googleaccessid',
]);
const returnParameters = new Set(['continue', 'destination', 'next', 'redirect', 'return', 'return_to', 'returnto']);

function withoutLocale(pathname: string): string {
  const [, first, ...rest] = pathname.split('/');
  if (locales.some((locale) => locale === first)) return `/${rest.join('/')}` || '/';
  return pathname;
}

function forbiddenPath(pathname: string): boolean {
  if (/%(?:2f|5c)/i.test(pathname)) return true;
  let decoded: string;
  try {
    decoded = decodeURI(pathname).toLowerCase();
  } catch {
    return true;
  }
  const path = withoutLocale(decoded);
  return /^\/(?:_serverfn|api|auth|oauth|oidc|\.well-known|media|download|downloads)(?:\/|$)/i.test(path);
}

function hasForbiddenParameters(params: URLSearchParams): boolean {
  for (const key of params.keys()) {
    const normalized = key.toLowerCase();
    if (oidcParameters.has(normalized) || credentialParameters.has(normalized)) return true;
  }
  return false;
}

function decodeIntent(value: string): string | null {
  let decoded = value;
  for (let depth = 0; depth < 2; depth++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  return decoded;
}

function hasUnsafeReturnIntent(params: URLSearchParams): boolean {
  for (const [key, value] of params) {
    if (!returnParameters.has(key.toLowerCase())) continue;
    const target = decodeIntent(value);
    if (!target?.startsWith('/') || target.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(target)) return true;
    let url: URL;
    try {
      url = new URL(target, origin);
    } catch {
      return true;
    }
    if (
      url.origin !== origin ||
      forbiddenPath(url.pathname) ||
      hasForbiddenParameters(url.searchParams) ||
      hasForbiddenParameters(new URLSearchParams(url.hash.slice(1)))
    ) {
      return true;
    }
  }
  return false;
}

function safeAddress(location: LocaleNavigationLocation, preserveFragment: boolean) {
  if (!location.supported) return null;
  const { pathname, searchStr } = location;
  const hash = preserveFragment ? location.hash : '';
  if (
    !pathname.startsWith('/') ||
    pathname.includes('?') ||
    pathname.includes('#') ||
    /[\\\u0000-\u001f\u007f]/.test(pathname + searchStr + hash) ||
    (searchStr !== '' && (!searchStr.startsWith('?') || searchStr.includes('#'))) ||
    (hash !== '' && !hash.startsWith('#'))
  ) {
    return null;
  }

  let source: URL;
  try {
    source = new URL(`${pathname}${searchStr}${hash}`, origin);
  } catch {
    return null;
  }
  if (
    source.origin !== origin ||
    forbiddenPath(source.pathname) ||
    hasForbiddenParameters(source.searchParams) ||
    hasForbiddenParameters(new URLSearchParams(source.hash.slice(1))) ||
    hasUnsafeReturnIntent(source.searchParams)
  ) {
    return null;
  }

  let route: URL;
  try {
    route = new URL(deLocalizeHref(`${source.pathname}${source.search}${source.hash}`), origin);
  } catch {
    return null;
  }
  if (route.origin !== origin || forbiddenPath(route.pathname)) return null;
  return { pathname: route.pathname, searchStr: route.search, hash: route.hash };
}

function localHref(pathname: string, searchStr: string, hash: string, locale: Locale): string | null {
  const localized = localizeHref(`${pathname}${searchStr}${hash}`, { locale });
  try {
    const url = new URL(localized, origin);
    if (url.origin !== origin || forbiddenPath(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function localeHome(locale: Locale): LocaleDestination {
  const href = localHref('/', '', '', locale) ?? '/';
  return { locale, href, pathname: '/', searchStr: '', hash: '', kind: 'home' };
}

/** Unsupported and sensitive routes use the existing locale home as the explicit safe fallback. */
export function deriveLocaleDestinations(
  location: LocaleNavigationLocation,
  preserveFragment = true,
): readonly LocaleDestination[] {
  const address = safeAddress(location, preserveFragment);
  if (!address) return locales.map((locale) => localeHome(locale));

  return locales.map((locale) => {
    const href = localHref(address.pathname, address.searchStr, address.hash, locale);
    if (!href) return localeHome(locale);
    return { locale, href, ...address, kind: 'page' };
  });
}

export function isDestinationVisit(
  location: LocaleNavigationLocation,
  destination: LocaleDestination,
): boolean {
  if (location.locale !== destination.locale || !location.supported) return false;
  const address = safeAddress(location, true);
  return (
    address?.pathname === destination.pathname &&
    address.searchStr === destination.searchStr &&
    address.hash === destination.hash
  );
}

export function isSameLocaleVisit(left: LocaleNavigationLocation, right: LocaleNavigationLocation): boolean {
  return (
    left.locale === right.locale &&
    left.visitKey === right.visitKey &&
    left.pathname === right.pathname &&
    left.searchStr === right.searchStr &&
    left.hash === right.hash
  );
}
