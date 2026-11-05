import { candidateContext } from '../../subject/candidates';
import { keepSearch, subjectHref, type SubjectHrefInput } from '../../subject/subject-href';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowed = new Set(['originContext', 'originRealm', 'reviewProperty', 'candidate']);

export type IdentifierVisitOrigin = {
  context?: string;
  realm?: string;
  realmTitle?: string;
  state?: 'current' | 'changed' | 'missing' | 'refused' | 'unavailable';
  kind: 'global' | 'realm' | 'unsupported';
};

export type IdentifierCurrentVisit = {
  origin?: IdentifierVisitOrigin;
  initialReview?: { property: string; candidate: string };
};

export type IdentifierVisitSelection = {
  context?: string | undefined;
  realm?: string | undefined;
};

/** Parse one bounded Identifier visit. Unknown, duplicate and contradictory operands fail closed. */
export function parseIdentifierCurrentVisit(search: string): IdentifierCurrentVisit | null {
  const query = search.split('#', 1)[0]!.replace(/^\?/u, '');
  if (query.length > 2048 || new TextEncoder().encode(query).byteLength > 2048) return null;
  const params = new URLSearchParams(query);
  for (const key of params.keys()) if (!allowed.has(key)) return null;
  for (const key of allowed) if (params.getAll(key).length > 1) return null;

  const context = params.get('originContext') ?? undefined;
  const realm = params.get('originRealm') ?? undefined;
  if ((context !== undefined && !uuid.test(context)) || (realm !== undefined && !uuid.test(realm))) return null;
  if (realm && context === candidateContext) return null;

  const reviewProperty = params.get('reviewProperty') ?? undefined;
  const candidate = params.get('candidate') ?? undefined;
  if (
    (reviewProperty !== undefined &&
      (!reviewProperty.trim() || reviewProperty.length > 256 || /[\u0000-\u001f\u007f]/u.test(reviewProperty))) ||
    (candidate !== undefined && !uuid.test(candidate)) ||
    (reviewProperty === undefined) !== (candidate === undefined)
  )
    return null;

  const hasOrigin = context !== undefined || realm !== undefined;
  const origin: IdentifierVisitOrigin | undefined = hasOrigin
    ? {
        ...(context ? { context } : {}),
        ...(realm ? { realm } : {}),
        kind: realm ? 'realm' : context === candidateContext ? 'global' : 'unsupported',
      }
    : undefined;
  return {
    ...(origin ? { origin } : {}),
    ...(reviewProperty && candidate ? { initialReview: { property: reviewProperty, candidate } } : {}),
  };
}

/** The menu records only the selected Context and the existing public Realm selector. */
export function identifierVisitHref(subject: SubjectHrefInput, locale: string, selection: IdentifierVisitSelection) {
  const path = subjectHref(subject, locale);
  return identifierRouteHref(locale, path.params.id, path.params.slug, {
    ...(selection.context
      ? {
          origin: {
            context: selection.context,
            ...(selection.realm ? { realm: selection.realm } : {}),
            kind: selection.realm ? 'realm' : selection.context === candidateContext ? 'global' : 'unsupported',
          },
        }
      : {}),
    ...(selection.realm && !selection.context ? { origin: { realm: selection.realm, kind: 'realm' } } : {}),
  });
}

/** Canonical route address for an installed visit, limited to the one supported Realm selector. */
export function identifierRouteHref(
  locale: string,
  id: string,
  slug: string,
  visit: Pick<IdentifierCurrentVisit, 'origin'>,
) {
  const base = `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}/${slug}/identifiers`;
  const params = new URLSearchParams();
  if (visit.origin?.context) params.set('originContext', visit.origin.context);
  if (visit.origin?.realm) params.set('originRealm', visit.origin.realm);
  const query = params.toString();
  return query ? keepSearch(base, query) : base;
}

/** A public return address keeps the established Realm selector and carries no nested visit state. */
export function identifierOriginHref(subject: SubjectHrefInput, locale: string, origin?: IdentifierVisitOrigin) {
  const base = subjectHref(subject, locale).href;
  return origin?.realm ? keepSearch(base, new URLSearchParams({ realm: origin.realm }).toString()) : base;
}

/** Add review intent to the current editor address while preserving its bounded visit origin. */
export function identifierReviewHref(editorHref: string, property: string, candidate: string) {
  const [pathAndSearch, hash = ''] = editorHref.split('#', 2);
  const [path, search = ''] = pathAndSearch!.split('?', 2);
  const params = new URLSearchParams(search);
  params.set('reviewProperty', property);
  params.set('candidate', candidate);
  return keepSearch(path!, params.toString(), hash);
}
