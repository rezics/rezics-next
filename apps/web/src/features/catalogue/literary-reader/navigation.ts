import type { PageContinuation } from '@rezics/composition';
import { subjectViewHref } from '../../../subject/subject-href';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';

/** Keep the native page node and its opaque cursor together, including on a return visit. */
export function literaryAddress(input: {
  id: string;
  label: string;
  locale: string;
  view: string;
  realm?: string | undefined;
  continuation?: PageContinuation | undefined;
}): string {
  const url = new URL(subjectViewHref(input, input.locale, input.view), 'https://rezics.invalid');
  if (input.realm) url.searchParams.set('realm', input.realm);
  if (input.continuation) {
    url.searchParams.set('node', input.continuation.node);
    url.searchParams.set('cursor', input.continuation.cursor);
  }
  return `${url.pathname}${url.search}#literary-reader`;
}

export function literaryDestination(id: string, label: string, locale: string, returnTo: string, realm?: string) {
  const href = literaryAddress({ id, label, locale, view: 'overview', realm }).replace(/#literary-reader$/, '');
  return withSubjectVisitReturn(href, returnTo, locale);
}
