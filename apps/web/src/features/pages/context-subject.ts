import type { KernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT } from '@rezics/composition';
import { createServerOnlyFn } from '@tanstack/react-start';
import type { PagePaths } from '../../shell/head';
import { locales } from '../../paraglide/runtime.js';
import { accountHref, subjectHref } from '../../subject/subject-href';
import { loadSubjectPage, PageReadError, subjectPageTitle, subjectBody, type SubjectPageData } from './subject';

/** Canonical identity uses the same selected reading as the page, never an anonymous Global label probe. */
export const loadContextSubject = createServerOnlyFn(async function loadContextSubject(
  client: KernelClient,
  id: string,
  locale: string,
  options: { realm?: string | undefined; authorization?: string | undefined; signal?: AbortSignal | undefined } = {},
) {
  options.signal?.throwIfAborted();
  if (!options.realm) {
    const { loadSubject } = await import('../../subject/load-subject');
    options.signal?.throwIfAborted();
    return loadSubject(client, id, locale as never, options.signal);
  }
  let loaded = await loadSubjectPage(client, id, undefined, locale, options);
  options.signal?.throwIfAborted();
  if (loaded.kind === 'redirect' && loaded.target !== 'account') {
    options.signal?.throwIfAborted();
    loaded = await loadSubjectPage(client, loaded.id, undefined, locale, options);
    options.signal?.throwIfAborted();
  }
  if (loaded.kind === 'missing') return loaded;
  if (loaded.kind === 'redirect') {
    if (loaded.target !== 'account') throw new PageReadError('dependency_unavailable', 503);
    const handle = loaded.id;
    return {
      kind: 'subject' as const,
      value: {
        id,
        slug: '',
        href: accountHref(locale, handle),
        paths: Object.fromEntries(
          locales.map((language) => [language, `/@${encodeURIComponent(handle)}`]),
        ) as PagePaths,
      },
    };
  }
  return { kind: 'subject' as const, value: contextSubjectAddress(loaded.page, locale) };
});

export function contextSubjectAddress(page: SubjectPageData, locale: string) {
  if (!page.subject || !subjectBody(page)) throw new PageReadError('dependency_unavailable', 503);
  const address = subjectHref({ id: page.subject, label: subjectPageTitle(page, locale) }, locale);
  return {
    id: page.subject,
    slug: address.params.slug,
    href: address.href,
    paths: Object.fromEntries(
      locales.map((language) => [
        language,
        subjectHref({ id: page.subject!, label: subjectPageTitle(page, language) }, language).href.slice(
          `/${language}`.length,
        ),
      ]),
    ) as PagePaths,
  };
}

/** Separate aggregate calls may each be current while selecting different Contexts. Never combine those replies. */
export function assertSamePageContext(first: SubjectPageData, final: SubjectPageData) {
  const selection = (page: SubjectPageData) => [
    page.context?.id ?? PAGE_GLOBAL_CONTEXT,
    page.context?.population.kind ?? 'global',
    page.context?.population.kind === 'realm' ? page.context.population.id : null,
    page.context?.population.kind === 'realm' ? page.context.population.title : null,
  ];
  if (first.subject !== final.subject || JSON.stringify(selection(first)) !== JSON.stringify(selection(final)))
    throw new PageReadError('dependency_unavailable', 503);
}
