import { candidateContext } from '../visit-host-port';
import { subjectHref } from '../../../subject/load-subject';
import { subjectVisitReturn } from '../subject-visit-navigation';

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
  if (typeof value !== 'string' || !graphPublicIntentFits(value)) return;
  const accepted = subjectVisitReturn(value, locale);
  if (!accepted || !graphPublicIntentFits(accepted)) return;
  const url = new URL(accepted, 'https://rezics.invalid');
  const path = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  const returnedContext = url.searchParams.get('context') ?? candidateContext;
  if (
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
  if (typeof value !== 'string' || !graphPublicIntentFits(value)) return;
  const admitted = subjectVisitReturn(value, locale);
  if (!admitted) return;
  const url = new URL(admitted, 'https://rezics.invalid');
  const context = url.searchParams.get('context') ?? candidateContext;
  const realm = url.searchParams.get('realm') ?? undefined;
  return graphPublicReturn(admitted, id, locale, context, realm);
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
  if (visit?.kind === 'origin') return { origin: JSON.stringify(visit.origin) };
  if (visit?.kind === 'global') return { publicReturn: visit.returnHref };
  return {};
}

export function graphDirectHref(id: string, label: string, locale: string): string {
  return `${subjectHref({ id, label }, locale).href}/graph`;
}
