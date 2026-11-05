import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import type { Subject } from '../../../subject/types';
import { subjectHref } from '../../../subject/subject-href';
import { contextHref } from '../../pages/context-navigation';
import { withSubjectVisitReturn } from '../../pages/subject-visit-navigation';
import { namesReturnHref } from '../work-names/navigation';
import type { PeopleNames } from './model';

/** The native Context belongs to the origin; Sources accepts Realm, and Terms reads Global. */
export function peopleNamesAddress(subject: Subject, names: PeopleNames, locale: string) {
  const href = subjectHref({ id: subject.id, label: names.state === 'ready' ? names.selected.text : '' }, locale).href;
  const origin = `${href}?${new URLSearchParams({ context: subject.context })}`;
  const returnHref = namesReturnHref(origin, locale);
  return {
    returnHref,
    supported: subject.context === PAGE_GLOBAL_CONTEXT,
    sourcesHref: withSubjectVisitReturn(`${href}/sources`, returnHref ?? '', locale),
    termsHref: withSubjectVisitReturn(`${href}/terms`, returnHref ?? '', locale),
  };
}

/** PageLink owns Realm selection. Complete real hrefs before modifier/new-tab activation too. */
export function installPeopleNamesReturn(host: HTMLElement, returnHref: string | undefined, locale: string) {
  if (!returnHref) return;
  for (const anchor of host.querySelectorAll<HTMLAnchorElement>('[data-names-sources] a, [data-names-terms] a')) {
    const destination = new URL(anchor.href);
    if (destination.origin !== window.location.origin) continue;
    const selectedReturn = contextHref(returnHref, destination.searchParams.get('realm') ?? undefined);
    destination.searchParams.delete('via');
    anchor.setAttribute(
      'href',
      withSubjectVisitReturn(`${destination.pathname}${destination.search}${destination.hash}`, selectedReturn, locale),
    );
  }
}
