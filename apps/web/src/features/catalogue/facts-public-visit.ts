import { candidateContext } from '../../subject/candidates';
import { subjectVisitReturn } from '../pages/subject-visit-navigation';

/** A public observation, never a selected correction assertion or mutation operand. */
export type FactsPublicOrigin = {
  subject: string;
  context: string;
  realm?: string;
  returnHref: string;
};

export type FactsPublicVisit =
  | { kind: 'legacy' }
  | { kind: 'origin'; origin: FactsPublicOrigin }
  | { kind: 'fresh'; returnHref: string }
  | { kind: 'invalid' };

export const factsPublicIntentLimit = 2048;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const localOrigin = 'https://rezics.invalid';

/** The complete retained editor search pays both existing address ceilings after encoding. */
export function factsPublicIntentFits(value: string): boolean {
  return value.length <= factsPublicIntentLimit && encoder.encode(value).byteLength <= factsPublicIntentLimit;
}

function publicReturn(value: unknown, subject: string, locale: string): { href: string; realm?: string } | undefined {
  if (typeof value !== 'string' || !factsPublicIntentFits(value) || !value.startsWith('/') || value.startsWith('//'))
    return;
  const href = subjectVisitReturn(value, locale);
  if (!href || !factsPublicIntentFits(href)) return;
  const url = new URL(href, localOrigin);
  const path = url.pathname.split('/');
  const keys = [...url.searchParams.keys()];
  const realms = url.searchParams.getAll('realm');
  if (
    url.origin !== localOrigin ||
    path[1] !== locale ||
    path[2] !== 'subjects' ||
    path[3] !== subject ||
    path.length !== 5 ||
    !path[4] ||
    url.hash !== '#connections' ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== 'realm') ||
    realms.length > 1 ||
    (realms[0] !== undefined && !uuid.test(realms[0]))
  )
    return;
  return { href, ...(realms[0] ? { realm: realms[0] } : {}) };
}

function normalizeOrigin(value: unknown, subject: string, locale: string): FactsPublicOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const origin = value as Record<string, unknown>;
  if (
    Object.keys(origin).some((key) => !['subject', 'context', 'realm', 'returnHref'].includes(key)) ||
    origin.subject !== subject ||
    !uuid.test(subject) ||
    typeof origin.context !== 'string' ||
    !uuid.test(origin.context) ||
    (origin.realm !== undefined && (typeof origin.realm !== 'string' || !uuid.test(origin.realm)))
  )
    return;
  const realm = origin.realm as string | undefined;
  const returned = publicReturn(origin.returnHref, subject, locale);
  if (!returned || returned.realm !== realm) return;
  return {
    subject,
    context: origin.context,
    ...(realm ? { realm } : {}),
    returnHref: returned.href,
  };
}

/** The menu and direct entry use the same closed public descriptor and never perform a read. */
export function factsPublicCorrectionHref(
  base: string,
  subject: string,
  locale: string,
  origin: FactsPublicOrigin,
): string {
  const invalid = `${base}?origin=!`;
  const admitted = normalizeOrigin(origin, subject, locale);
  if (!admitted) return invalid;
  const href = `${base}?${new URLSearchParams({ origin: JSON.stringify(admitted) })}`;
  return factsPublicIntentFits(href) ? href : invalid;
}

/** A deliberate fresh Global visit keeps only the already validated public return. */
export function factsGlobalVisitHref(base: string, subject: string, locale: string, returnHref: string): string {
  const returned = publicReturn(returnHref, subject, locale);
  if (!returned) return `${base}?publicReturn=!`;
  const href = `${base}?${new URLSearchParams({ publicReturn: returned.href })}`;
  return factsPublicIntentFits(href) ? href : `${base}?publicReturn=!`;
}

function parseOrigin(raw: string, subject: string, locale: string): FactsPublicOrigin | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof value === 'string') {
    const nested = value;
    try {
      value = JSON.parse(nested);
    } catch {
      return;
    }
    const origin = normalizeOrigin(value, subject, locale);
    return origin && JSON.stringify(origin) === nested && JSON.stringify(nested) === raw ? origin : undefined;
  }
  const origin = normalizeOrigin(value, subject, locale);
  return origin && JSON.stringify(origin) === raw ? origin : undefined;
}

/** HTTP route/search boundary. Legacy exact-review searches remain under their existing parser. */
export function parseFactsPublicVisit(
  search: string,
  subject: string,
  locale: string,
  canonicalPath: string,
): FactsPublicVisit {
  const query = search.split('#', 1)[0] ?? '';
  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  const hasOrigin = params.has('origin');
  const hasFreshReturn = params.has('publicReturn');
  const malformedVisitKey = /(?:^|[?&])(?:origin|publicReturn)%(?![0-9a-f]{2})/i.test(search);
  if (malformedVisitKey) return { kind: 'invalid' };
  if (!hasOrigin && !hasFreshReturn) return { kind: 'legacy' };
  if (
    !factsPublicIntentFits(`${canonicalPath}${search}`) ||
    /%(?![0-9a-f]{2})/i.test(search) ||
    /#/.test(search) ||
    new Set(keys).size !== keys.length ||
    keys.length !== 1
  )
    return { kind: 'invalid' };
  if (hasOrigin) {
    const raw = params.get('origin');
    if (!raw) return { kind: 'invalid' };
    const origin = parseOrigin(raw, subject, locale);
    return origin ? { kind: 'origin', origin } : { kind: 'invalid' };
  }
  const returned = publicReturn(params.get('publicReturn'), subject, locale);
  return returned ? { kind: 'fresh', returnHref: returned.href } : { kind: 'invalid' };
}

export function factsPublicVisitUnsupported(visit: FactsPublicVisit): boolean {
  return visit.kind === 'origin' && (visit.origin.context !== candidateContext || !!visit.origin.realm);
}
