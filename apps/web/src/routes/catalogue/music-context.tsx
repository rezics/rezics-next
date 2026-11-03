import { createFileRoute } from '@tanstack/react-router';
import { MusicContextCreateSession } from '../../features/catalogue/music-context-create-session';
import { loadMusicContextCreate } from '../../features/catalogue/music-context-create-actions';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/music-context')({
  staticData: { publicCache: false },
  loader: () => loadMusicContextCreate({ data: false }),
  head: () => ({ meta: [{ title: m.music_context_create_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => <MusicContextCreateSession locale={getLocale()} initial={Route.useLoaderData()} />,
});
