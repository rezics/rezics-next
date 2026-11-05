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
    creditHandoff:
      typeof input.creditHandoff === 'string' && /^[0-9a-f-]{36}$/i.test(input.creditHandoff)
        ? input.creditHandoff
        : undefined,
  }),
  head: () => ({ meta: [{ title: m.people_profile_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => {
    const { work, creditHandoff } = Route.useSearch();
    return (
      <PeopleProfileSession
        key={`${work ?? ''}:${creditHandoff ?? ''}`}
        {...(work !== undefined ? { work } : {})}
        {...(creditHandoff ? { creditHandoffToken: creditHandoff } : {})}
        locale={getLocale()}
      />
    );
  },
});
