import { subjectHref } from '../../../subject/subject-href';
import { subjectVisitReturn, withSubjectVisitReturn, personBiographyReturnFragment } from '../../pages/subject-visit-navigation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type PeopleBiographyWindow = 'biography' | 'occupations' | 'languages' | 'affiliations';

/** One bounded source address for returning to the current Person field and assertion. */
export function peopleBiographyAddress(
  id: string,
  label: string,
  locale: string,
  context: string,
  window: PeopleBiographyWindow,
  field: string,
  assertion?: string,
): string {
  const base = subjectHref({ id, label }, locale).href;
  const params = new URLSearchParams({ context });
  const fragment = personBiographyReturnFragment({ context, window, field, ...(assertion ? { assertion } : {}) });
  return `${base}/people?${params}${fragment}`;
}

/** Add only the admitted Context and the single validated return address to an existing editor. */
export function peopleBiographyEditorHref(
  href: string,
  context: string,
  returnHref: string,
  locale: string,
  property?: string,
): string {
  const url = new URL(href, 'https://rezics.invalid');
  if (uuid.test(context)) url.searchParams.set('context', context);
  if (property) url.searchParams.set('property', property);
  const current = `${url.pathname}${url.search}${url.hash}`;
  return withSubjectVisitReturn(current, subjectVisitReturn(returnHref, locale) ?? '', locale);
}

/** Disclosed target links retain this Context and return through the existing Subject visit facility. */
export function peopleBiographyTargetHref(
  id: string,
  label: string,
  locale: string,
  context: string,
  returnHref: string,
): string {
  const url = new URL(subjectHref({ id, label }, locale).href, 'https://rezics.invalid');
  if (uuid.test(context)) url.searchParams.set('context', context);
  return withSubjectVisitReturn(`${url.pathname}${url.search}`, returnHref, locale);
}
