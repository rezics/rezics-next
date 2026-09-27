import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import { readRealm } from '../../../features/discover/read.ts';
import { type SearchParams, shortId } from '../../../features/discover/scope.ts';
import { browseReader } from '../../../features/discover/server.ts';
import { readSearchPage } from '../../../features/search/read.ts';
import { SearchPage } from '../../../features/search/search-page.tsx';
import { parseSearchState, phraseStatus } from '../../../features/search/state.ts';
import { Providers } from '../../../features/shell/providers.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../i18n/server.ts';

type Props = { searchParams: Promise<SearchParams> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const [params, locale] = await Promise.all([searchParams, requestLocale()]);
  const { t } = await getTranslation('search', [locale]);
  const parsed = parseSearchState(params);
  const phrase = parsed.ok ? parsed.state.phrase : parsed.phrase;
  // A result page is a view of the index, not a document: keep it out of search engines.
  return phrase ? { title: `“${phrase}” · ${t.title}`, robots: { index: false } } : { title: t.title };
}

export default async function SearchRoute({ searchParams }: Props) {
  const [params, locale] = await Promise.all([searchParams, requestLocale()]);
  const [messages, discoverMessages, reader] = await Promise.all([getMessages('search', locale),
    getMessages('discover', locale), browseReader()]);
  const parsed = parseSearchState(params);
  const state = parsed.ok ? parsed.state : null;
  const [realm, initial] = await Promise.all([
    state?.scope.kind === 'realm' ? readRealm(reader.anonymous, state.scope.realm, locale) : null,
    state && phraseStatus(state.phrase) === 'ok'
      // The session's token applies its mutes; names are public, so they are read anonymously.
      ? readSearchPage({ search: reader.personal, names: reader.anonymous }, state, { language: locale })
      : null,
  ]);
  const option = state?.scope.kind === 'realm' ? { id: state.scope.realm,
    label: realm?.ok ? realm.data.name.value
      : materializeData(discoverMessages, { locale }).realmFallback({ id: shortId(state.scope.realm) }),
    lang: realm?.ok ? realm.data.name.language : undefined } : null;
  return <Providers>
    <SearchPage parsed={parsed} realm={option} initial={initial} signedIn={reader.signedIn}
      actingSubject={reader.actingSubject} avatarQuery={reader.avatarQuery} locale={locale} messages={messages}
      discoverMessages={discoverMessages} />
  </Providers>;
}
