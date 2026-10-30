import { createFileRoute } from '@tanstack/react-router';
import { CharacterProfileSession } from '../../features/catalogue/character-profile-session';
import { getLocale } from '../../paraglide/runtime';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/catalogue/character')({
  staticData: { publicCache: false },
  validateSearch: (input: Record<string, unknown>) => ({
    work: typeof input.work === 'string' ? input.work : undefined,
  }),
  head: () => ({ meta: [{ title: m.character_title() }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: CharacterRoute,
});
function CharacterRoute() {
  return <CharacterProfileSession locale={getLocale()} work={Route.useSearch().work} />;
}
