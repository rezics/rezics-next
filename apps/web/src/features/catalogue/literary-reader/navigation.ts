import type { PageContinuation, SelectedContext } from '@rezics/composition';
import { subjectViewHref } from '../../../subject/subject-href';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import type { LiteraryPreviousAddress } from '../literary-visit/navigation';

const addressLimit = 32768;

/** Keep the native page node and its opaque cursor together, including on a return visit. */
export function literaryAddress(input: {
  id: string;
  label: string;
  locale: string;
  view: string;
  realm?: string | undefined;
  context?: SelectedContext | null | undefined;
  node?: string | undefined;
  continuation?: PageContinuation | undefined;
  focus?: string | undefined;
  previous?: readonly LiteraryPreviousAddress[] | undefined;
}): string {
  const url = new URL(subjectViewHref(input, input.locale, input.view), 'https://rezics.invalid');
  if (input.realm) url.searchParams.set('realm', input.realm);
  if (input.context?.id) url.searchParams.set('context', input.context.id);
  if (input.node) url.searchParams.set('node', input.node);
  if (input.continuation) {
    url.searchParams.set('node', input.continuation.node);
    url.searchParams.set('cursor', input.continuation.cursor);
  }
  if (input.focus) url.searchParams.set('focus', input.focus);
  let previous = [...(input.previous ?? [])].slice(-8);
  let href = '';
  while (true) {
    url.searchParams.delete('history');
    if (previous.length) url.searchParams.set('history', JSON.stringify(previous));
    href = `${url.pathname}${url.search}#literary-reader`;
    if (href.length <= addressLimit || previous.length === 0) break;
    previous = previous.slice(1);
  }
  return href;
}

export function literaryDestination(
  id: string,
  label: string,
  locale: string,
  returnTo: string,
  realm?: string,
  context?: SelectedContext | null,
) {
  const href = literaryAddress({ id, label, locale, view: 'overview', realm, context }).replace(/#literary-reader$/, '');
  return withSubjectVisitReturn(href, returnTo, locale);
}
