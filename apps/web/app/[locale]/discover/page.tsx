import type { Metadata } from 'next';
import { signInPath } from '../../../features/auth/paths.ts';
import { DiscoverPage, type LoadedShelf } from '../../../features/discover/discover-page.tsx';
import { readContextQuestion, readDiscovery, readRealm } from '../../../features/discover/read.ts';
import type { SearchParams } from '../../../features/discover/scope.ts';
import { browseReader } from '../../../features/discover/server.ts';
import { discoverHref, discoveryQuery, parseDiscoverState, shelvesFor } from '../../../features/discover/state.ts';
import { Providers } from '../../../features/shell/providers.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../i18n/server.ts';
import { localizedPath } from '../../../i18n/locale.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('discover', [await requestLocale()]);
  return { title: t.title };
}

// Overview shelves fill one row on a wide screen; a filtered view shows two.
const OVERVIEW_PAGE = 6;
const FOCUSED_PAGE = 12;

export default async function DiscoverRoute({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [params, locale] = await Promise.all([searchParams, requestLocale()]);
  const messages = await getMessages('discover', locale);
  const state = parseDiscoverState(params);
  const reader = await browseReader();
  const common = { signInHref: signInPath(localizedPath(state ? discoverHref(state) : '/discover', locale)),
    avatarQuery: reader.avatarQuery, locale, messages };
  if (!state) {
    return <DiscoverPage state={null} realm={null} question={null} shelves={[]} {...common} />;
  }
  const { scope } = state;
  const mine = scope.kind === 'mine';
  const limit = state.type || state.term ? FOCUSED_PAGE : OVERVIEW_PAGE;
  const [realm, question, shelves] = await Promise.all([
    scope.kind === 'realm' ? readRealm(reader.anonymous, scope.realm, locale) : null,
    state.context ? readContextQuestion(reader.anonymous, scope, state.context) : null,
    Promise.all(shelvesFor(state).map(async (spec): Promise<LoadedShelf> => {
      const query = discoveryQuery(state, spec, { limit, language: locale, actingSubject: reader.actingSubject });
      // Mine is this person's own population; without a session Agent there is nothing to read.
      const initial = mine && !reader.actingSubject ? { ok: false as const, failure: 'sign-in' as const }
        : await readDiscovery(mine ? reader.personal : reader.anonymous, query);
      return { spec, query, initial };
    })),
  ]);
  return <Providers>
    <DiscoverPage state={state} shelves={shelves} question={question?.ok ? question.data : null}
      realm={scope.kind === 'realm' ? { id: scope.realm, name: realm?.ok ? realm.data.name : null } : null}
      realmMissing={realm?.ok === false && realm.failure === 'missing'} {...common} />
  </Providers>;
}
