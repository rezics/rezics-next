import { createFileRoute } from '@tanstack/react-router';
import { GameProfileSession } from '../../features/catalogue/game-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/game')({
  staticData: { publicCache: false },
  head: () => ({ meta: [{ title: m.game_profile_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: () => <GameProfileSession locale={getLocale()} />,
});
