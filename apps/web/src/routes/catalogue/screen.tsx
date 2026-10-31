import { createFileRoute } from '@tanstack/react-router';
import { ScreenProfileSession } from '../../features/catalogue/screen-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/screen')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.screen_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => <ScreenProfileSession locale={getLocale()} />,
});
