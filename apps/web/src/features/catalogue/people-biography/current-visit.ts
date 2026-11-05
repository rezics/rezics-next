import { subjectHref } from '../../../subject/subject-href';
import { createContext } from 'react';
import {
  subjectVisitReturn,
  withSubjectVisitReturn,
  personBiographyReturnFragment,
} from '../../pages/subject-visit-navigation';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type PeopleBiographyWindow = 'biography' | 'occupations' | 'languages' | 'affiliations';
export const PeopleBiographyOuterReturn = createContext<string | undefined>(undefined);

/** One bounded source address for returning to the current Person field and assertion. */
export function peopleBiographyAddress(
  id: string,
  label: string,
  locale: string,
  context: string,
  window: PeopleBiographyWindow,
  field: string,
  assertion?: string,
  outerReturn?: string,
): string {
  const base = subjectHref({ id, label }, locale).href;
  const params = new URLSearchParams({ context });
  if (outerReturn) {
    // The existing nested visit grammar admits the overview's connections anchor.
    // The People route restores the separate public profile heading after rereading.
    const outer = new URL(outerReturn, 'https://rezics.invalid');
    outer.hash = 'connections';
    params.set('via', `${outer.pathname}${outer.search}${outer.hash}`);
  }
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
