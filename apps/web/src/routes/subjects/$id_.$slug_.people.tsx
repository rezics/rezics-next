import { createFileRoute } from '@tanstack/react-router';
import { PeopleProfileSession } from '../../features/catalogue/people-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/subjects/$id_/$slug_/people')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.people_profile_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => <PeopleProfileSession id={Route.useParams().id} locale={getLocale()} />,
});
