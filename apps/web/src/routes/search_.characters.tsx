import { createFileRoute } from '@tanstack/react-router';
import * as v from 'valibot';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { CharacterPersonSearchPage } from '../search/character-person-search';
import { parseCharacterPersonSearch } from '../search/character-person';

export const Route = createFileRoute('/search_/characters')({
  staticData: { publicCache: false },
  validateSearch: v.objectWithRest({}, v.unknown()),
  loaderDeps: ({ search }) => parseCharacterPersonSearch(search, getLocale()),
  component: CharacterPersonRoute,
});

function CharacterPersonRoute() {
  const raw = Route.useSearch();
  const parsed = parseCharacterPersonSearch(raw, getLocale());
  const session = useSession();
  const principal = session.state === 'signed-in' ? `signed-in:${session.subject ?? ''}` : session.state;
  const locale = getLocale();
  return (
    <CharacterPersonSearchPage
      key={JSON.stringify([locale, parsed.form, parsed.error])}
      locale={locale}
      parsed={parsed}
      principal={principal}
    />
  );
}
