import { candidateContext } from '../../catalogue/candidate-context';

/** Public route intent only; it never describes native advice, evidence or permission. */
export type GraphPublicOrigin = {
  subject: string;
  context: string;
  locale: string;
  realm?: string;
  returnHref: string;
};

export type GraphPublicVisit =
  | { kind: 'origin'; origin: GraphPublicOrigin }
  | { kind: 'global'; returnHref: string }
  | { kind: 'invalid' };

export const graphPublicIntentLimit = 2048;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const selectorKeys = ['property', 'direction', 'depth', 'node', 'edge', 'from', 'to', 'edgeProperty'];
const routeKeys = new Set([...selectorKeys, 'origin', 'publicReturn']);
const selectorId = /^[0-9a-f-]{36}$/i;

// Shared Subject path grammar; graph returns admit only the immediate heading subset below.
const subjectUuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const subjectDestination = new RegExp(
  `^/(en|zh-Hant|zh-Hans|ja|ko|fr|de|es)/subjects/${subjectUuid}/[^/?#]+(?:/([^/?#]+))?$`,
);

/** Path checks shared by public graph intent and the broader Subject return parser. */
export function subjectReturnPathAllowed(value: string): boolean {
  const rawPath = value.split(/[?#]/u, 1)[0] ?? '';
  if (/%(?:2f|5c)/iu.test(rawPath)) return false;
  try {
    const decodedPath = decodeURIComponent(rawPath);
    return !(
      decodedPath.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(decodedPath) ||
      decodedPath.split('/').some((segment) => segment === '.' || segment === '..') ||
      /%(?:25|2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/iu.test(decodedPath)
    );
  } catch {
    return false;
  }
}

function validContext(value: string): boolean {
  return value === candidateContext || uuid.test(value);
}

export function graphPublicIntentFits(address: string): boolean {
  return address.length <= graphPublicIntentLimit && encoder.encode(address).byteLength <= graphPublicIntentLimit;
}

/** Router paths omit the locale prefix; public graph links and their address budget include it. */
export function graphPublicPath(pathname: string, locale: string): string {
  const prefix = `/${encodeURIComponent(locale)}`;
  if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return pathname;
  return pathname.startsWith('/') ? `${prefix}${pathname}` : `${prefix}/${pathname}`;
}

function graphPublicReturn(
  value: unknown,
  id: string,
  locale: string,
  context: string,
  realm?: string,
): string | undefined {
  if (
    typeof value !== 'string' ||
    !graphPublicIntentFits(value) ||
    !value.startsWith(`/${locale}/subjects/${id}/`) ||
    /[\\\u0000-\u001f\u007f]/u.test(value) ||
    !subjectReturnPathAllowed(value)
  )
    return;
  const url = new URL(value, 'https://rezics.invalid');
  const path = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  const returnedContext = url.searchParams.get('context') ?? candidateContext;
  if (
    url.origin !== 'https://rezics.invalid' ||
    !subjectDestination.test(url.pathname) ||
    !new RegExp(`^${subjectUuid}$`, 'i').test(returnedContext) ||
    (realm !== undefined && !new RegExp(`^${subjectUuid}$`).test(realm)) ||
    path.length !== 5 ||
    path[1] !== locale ||
    path[2] !== 'subjects' ||
    path[3] !== id ||
    keys.some((key) => key !== 'context' && key !== 'realm') ||
    new Set(keys).size !== keys.length ||
    returnedContext !== context ||
    (url.searchParams.get('realm') ?? undefined) !== realm ||
    url.hash !== '#subject-heading'
  )
    return;
  // The heading subset shares path checks, never the return parser that consumes graph intent.
  const address = `${url.pathname}${url.search}${url.hash}`;
  return graphPublicIntentFits(address) ? address : undefined;
}

/** Build the one immediate return to the current Subject's heading, retaining only its public selectors. */
export function graphPublicSourceReturnHref({
  path,
  id,
  locale,
  context,
  realm,
}: {
  path: string;
  id: string;
  locale: string;
  context: string;
  realm?: string;
}): string | undefined {
  if (!uuid.test(id) || !validContext(context) || (realm !== undefined && !uuid.test(realm))) return;
  const query = new URLSearchParams({
    ...(context !== candidateContext ? { context } : {}),
    ...(realm ? { realm } : {}),
  });
  const encodedQuery = query.toString();
  const href = `${path}${encodedQuery ? `?${encodedQuery}` : ''}#subject-heading`;
  return graphPublicReturn(href, id, locale, context, realm);
}

export function graphPublicOriginHref(base: string, origin: GraphPublicOrigin): string {
  const value = {
    subject: origin.subject,
    context: origin.context,
    locale: origin.locale,
    ...(origin.realm === undefined ? {} : { realm: origin.realm }),
    returnHref: origin.returnHref,
  };
  const href = `${base}?${new URLSearchParams({ origin: encodeURIComponent(JSON.stringify(value)) })}`;
  const url = new URL(href, 'https://rezics.invalid');
  return graphPublicIntentFits(href) && graphPublicIntentFits(`${url.pathname}${url.search}${url.hash}`)
    ? href
    : `${base}?origin=!`;
}

/** A fresh Global choice carries only its validated public return, clearing graph selections and expansions. */
export function graphGlobalVisitHref(path: string, returnHref: string): string {
  const href = `${path}?${new URLSearchParams({ publicReturn: returnHref })}`;
  const url = new URL(href, 'https://rezics.invalid');
  return graphPublicIntentFits(href) && graphPublicIntentFits(`${url.pathname}${url.search}${url.hash}`)
    ? href
    : `${path}?origin=!`;
}

function validReturn(value: unknown, id: string, locale: string): string | undefined {
  if (typeof value !== 'string' || !graphPublicIntentFits(value) || !value.startsWith(`/${locale}/subjects/${id}/`))
    return;
  const url = new URL(value, 'https://rezics.invalid');
  const context = url.searchParams.get('context') ?? candidateContext;
  const realm = url.searchParams.get('realm') ?? undefined;
  return graphPublicReturn(value, id, locale, context, realm);
}

function validSelectors(params: URLSearchParams): boolean {
  const property = params.get('property');
  const direction = params.get('direction');
  const depth = params.get('depth');
  const node = params.get('node');
  const edge = params.get('edge');
  const from = params.get('from');
  const to = params.get('to');
  const edgeProperty = params.get('edgeProperty');
  return !(
    (property !== null && property.length > 512) ||
    (direction !== null && direction !== 'out' && direction !== 'in' && direction !== 'both') ||
    (depth !== null && depth !== '1' && depth !== '2') ||
    (node !== null && !selectorId.test(node)) ||
    (edge !== null && !selectorId.test(edge)) ||
    (from !== null && !selectorId.test(from)) ||
    (to !== null && !selectorId.test(to)) ||
    (edgeProperty !== null && !/^[^\s]{1,128}$/.test(edgeProperty)) ||
    (node !== null && edge !== null) ||
    (edge === null && (from !== null || to !== null || edgeProperty !== null)) ||
    (edge !== null && (from === null || to === null || edgeProperty === null))
  );
}

function originOf(value: unknown, id: string, locale: string): GraphPublicOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['subject', 'context', 'locale', 'realm', 'returnHref'].includes(key)) ||
    input.subject !== id ||
    !uuid.test(id) ||
    input.locale !== locale ||
    typeof input.context !== 'string' ||
    !validContext(input.context) ||
    (input.realm !== undefined && (typeof input.realm !== 'string' || !uuid.test(input.realm))) ||
    typeof input.returnHref !== 'string'
  )
    return;
  const context = input.context;
  const realm = input.realm as string | undefined;
  const returnHref = graphPublicReturn(input.returnHref, id, locale, context, realm);
  if (!returnHref) return;
  return {
    subject: id,
    context,
    locale,
    ...(realm ? { realm } : {}),
    returnHref,
  };
}

/** Parse the complete installed route address. Missing outer intent remains a legacy direct visit. */
export function parseGraphPublicVisit(
  search: string,
  hash: string,
  id: string,
  locale: string,
  canonicalPath: string,
): GraphPublicVisit | undefined {
  const address = new URL(`${canonicalPath}${search}${hash}`, 'https://rezics.invalid');
  const segments = address.pathname.split('/');
  const localized = segments.length === 6 && segments[1] === locale;
  const internal = segments.length === 5 && segments[1] === 'subjects';
  if (
    (!localized && !internal) ||
    segments[localized ? 2 : 1] !== 'subjects' ||
    segments[localized ? 3 : 2] !== id ||
    segments[localized ? 5 : 4] !== 'graph' ||
    !graphPublicIntentFits(`${canonicalPath}${search}${hash}`) ||
    !graphPublicIntentFits(`${address.pathname}${address.search}${address.hash}`) ||
    /%(?![0-9a-f]{2})/i.test(search) ||
    hash
  )
    return { kind: 'invalid' };

  const params = new URLSearchParams(search);
  const keys = [...params.keys()];
  if (keys.some((key) => !routeKeys.has(key)) || new Set(keys).size !== keys.length || !validSelectors(params))
    return { kind: 'invalid' };

  const rawOrigin = params.get('origin');
  const returnHref = params.get('publicReturn');
  if (rawOrigin === null && returnHref === null) return undefined;
  if (rawOrigin !== null && returnHref !== null) return { kind: 'invalid' };

  if (rawOrigin !== null) {
    let value: unknown;
    try {
      value = JSON.parse(decodeURIComponent(rawOrigin));
    } catch {
      return { kind: 'invalid' };
    }
    const origin = originOf(value, id, locale);
    return origin && encodeURIComponent(JSON.stringify(origin)) === rawOrigin
      ? { kind: 'origin', origin }
      : { kind: 'invalid' };
  }

  const admitted = validReturn(returnHref, id, locale);
  return admitted ? { kind: 'global', returnHref: admitted } : { kind: 'invalid' };
}

export function graphPublicVisitUnsupported(visit: GraphPublicVisit | undefined): boolean {
  return visit?.kind === 'origin' && (visit.origin.context !== candidateContext || !!visit.origin.realm);
}

export function graphPublicVisitReturn(visit: GraphPublicVisit | undefined): string | undefined {
  if (visit?.kind === 'origin') return visit.origin.returnHref;
  if (visit?.kind === 'global') return visit.returnHref;
  return undefined;
}

export function graphPublicVisitSearch(visit: GraphPublicVisit | undefined): Record<string, string> {
  if (visit?.kind === 'origin') return { origin: encodeURIComponent(JSON.stringify(visit.origin)) };
  if (visit?.kind === 'global') return { publicReturn: visit.returnHref };
  return {};
}
