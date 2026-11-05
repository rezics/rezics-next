import { createFileRoute } from '@tanstack/react-router';
import { PeopleProfileSession } from '../../features/catalogue/people-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';
import {
  peopleCurrentVisitReturnHref,
  validatePeopleCurrentVisitSearch,
} from '../../features/catalogue/people-current-visit';
import { PeopleCurrentVisitView } from '../../features/catalogue/people-current-visit-view';
import { keepSearch } from '../../subject/subject-href';

export const Route = createFileRoute('/subjects/$id_/$slug_/people')({
  staticData: { publicCache: false },
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
