import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { PeopleProfileSession } from '../../features/catalogue/people-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import {
  peopleCurrentVisitReturnHref,
  validatePeopleCurrentVisitSearch,
} from '../../features/catalogue/people-current-visit';
import { PeopleCurrentVisitView } from '../../features/catalogue/people-current-visit-view';
import { canonicalRedirect, keepSearch } from '../../subject/subject-href';

const canonicalPeopleProfile = createServerFn({ method: 'GET', strict: false })
  .validator((input: { id: string; slug: string; locale: string; search: string }) => {
    if (
      !input ||
      typeof input.id !== 'string' ||
      input.id.length > 128 ||
      typeof input.slug !== 'string' ||
      input.slug.length > 128 ||
      typeof input.locale !== 'string' ||
      typeof input.search !== 'string' ||
      input.search.length > 16384
    )
      throw notFound();
    return input;
  })
  .handler(async ({ data }) => {
    setResponseHeader('cache-control', 'private, no-store');
    const [{ kernelClient }, { loadSubject }] = await Promise.all([
      import('../../kernel/client'),
      import('../../subject/load-subject'),
    ]);
    // Only a merged or re-slugged Person redirects; every other outcome keeps the reader's own states.
    const canonical = await loadSubject(kernelClient(data.locale), data.id, data.locale as never).catch(() => null);
    if (canonical?.kind !== 'subject') return null;
    if (canonical.value.id !== data.id || canonical.value.slug !== data.slug)
      throw redirect(canonicalRedirect(`${canonical.value.href}/people`, data.search));
    return null;
  });

export const Route = createFileRoute('/subjects/$id_/$slug_/people')({
  staticData: { publicCache: false },
  loader: ({ params, location }) =>
    canonicalPeopleProfile({
      data: { ...params, locale: getLocale(), search: keepSearch('', location.searchStr, location.hash) },
    }),
  head: () => ({ meta: [{ title: m.people_profile_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  validateSearch: (search: Record<string, unknown>) => search,
  component: PeopleProfileRoute,
});

function PeopleProfileRoute() {
  const id = Route.useParams().id;
  const locale = getLocale();
  const search = Route.useSearch();
  const location = Route.useLocation();
  const hash = location.hash ? `#${location.hash.replace(/^#/, '')}` : '';
  const visit = validatePeopleCurrentVisitSearch(search, id, locale, hash);
  const address = JSON.stringify([location.pathname, location.searchStr, location.hash]);
  const returnAfterSignIn = keepSearch(location.pathname, location.searchStr, location.hash);
  return (
    <PeopleCurrentVisitView
      locale={locale}
      pathname={location.pathname}
      visit={visit}
      renderEditor={(origin, biographyReturn) => (
        <PeopleProfileSession
          id={id}
          locale={locale}
          address={address}
          returnAfterSignIn={returnAfterSignIn}
          {...(biographyReturn ? { returnHref: biographyReturn } : {})}
          {...(origin
            ? {
                origin,
                context: origin.context,
                ...(origin.realm ? { realm: origin.realm } : {}),
                returnHref: peopleCurrentVisitReturnHref(origin),
              }
            : {})}
        />
      )}
    />
  );
}
