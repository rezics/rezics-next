import { createFileRoute } from '@tanstack/react-router';
import { LiteraryProfileSession } from '../../features/catalogue/literary-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/literary')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.literary_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => <LiteraryProfileSession locale={getLocale()} />,
});
