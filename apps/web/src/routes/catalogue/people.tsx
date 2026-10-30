import { createFileRoute } from '@tanstack/react-router';
import { PeopleProfileSession } from '../../features/catalogue/people-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/people')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    work:
      input.work === undefined
        ? undefined
        : typeof input.work === 'string' && input.work.length <= 128
          ? input.work
          : '',
  }),
  head: () => ({ meta: [{ title: m.people_profile_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => {
    const { work } = Route.useSearch();
    return <PeopleProfileSession {...(work !== undefined ? { work } : {})} locale={getLocale()} />;
  },
});
