import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { addonPublicIntentFits, parseAddonPublicVisit } from '../../features/catalogue/addon-public-visit';
import { AddonProfileSession } from '../../features/catalogue/addon-profile-session';
import { classificationHandoffSearch } from '../../features/catalogue/classification-create-return';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import { canonicalRedirect, keepSearch, subjectHref } from '../../subject/subject-href';

const canonicalAddon = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      !addonPublicIntentFits(input.search)
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const { kernelClient } = await import('../../kernel/client');
    const { loadSubject } = await import('../../subject/load-subject');
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never);
    if (canonical.kind === 'missing') throw notFound();
    const path = `${subjectHref({ id: canonical.value.id, label: canonical.value.label }, data.locale).href}/addon`;
    const visit = parseAddonPublicVisit(data.search, data.id, data.locale, path);
    let search = data.search;
    if (visit?.kind === 'invalid' || (canonical.value.id !== data.id && visit)) {
      const params = new URLSearchParams(data.search);
      params.delete('publicReturn');
      params.delete('classificationHandoff');
      params.set('origin', '!');
      search = `?${params}`;
    }
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug)
      throw redirect(canonicalRedirect(path, search));
    return { id: canonical.value.id, visit };
  });
export const Route = createFileRoute('/subjects/$id_/$slug_/addon')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    work: typeof input.work === 'string' ? input.work : undefined,
    classificationHandoff: classificationHandoffSearch(input),
  }),
  loader: ({ params, location }) =>
    canonicalAddon({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.addon_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: AddonRoute,
});
function AddonRoute() {
  const { work, classificationHandoff } = Route.useSearch();
  return (
    <AddonProfileSession
      id={Route.useLoaderData().id}
      locale={getLocale()}
      work={work}
      visit={Route.useLoaderData().visit}
      {...(classificationHandoff ? { classificationHandoffToken: classificationHandoff } : {})}
    />
  );
}
