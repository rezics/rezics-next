import { createFileRoute } from '@tanstack/react-router';
import { MangaProfileSession } from '../../features/catalogue/manga-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/manga')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.manga_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => <MangaProfileSession locale={getLocale()} />,
});
