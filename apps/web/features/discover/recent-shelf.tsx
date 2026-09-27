import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { Providers } from '../shell/providers.tsx';
import { readDiscovery } from './read.ts';
import { browseReader } from './server.ts';
import { Shelf } from './shelf.tsx';
import { type DiscoverState, discoveryQuery, shelvesFor } from './state.ts';

const global: DiscoverState = { scope: { kind: 'global' }, context: null, type: null, term: null };

/** Discover's recent Global shelf for another page (Home), read on the server. */
export async function RecentShelf({ locale }: { locale: UiLocale }) {
  const [messages, reader] = await Promise.all([getMessages('discover', locale), browseReader()]);
  const t = materializeData(messages, { locale });
  const query = discoveryQuery(global, shelvesFor(global)[0]!, { limit: 6, language: locale });
  const initial = await readDiscovery(reader.anonymous, query);
  return <Providers>
    <Shelf title={t.recent} scopeLabel={t.global} scope={global.scope} query={query} initial={initial}
      browseAll={{ href: '/discover', label: t.openDiscover }} avatarQuery={reader.avatarQuery} locale={locale}
      messages={messages} />
  </Providers>;
}
