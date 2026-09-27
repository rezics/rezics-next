import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { Providers } from '../shell/providers.tsx';
import { shelfTitle } from './discover-view.tsx';
import { loadDiscover } from './load.ts';
import { DiscoverShelf } from './shelf.tsx';
import { discoverHref } from './state.ts';

/**
 * Discover's leading overview rows for another page (the home feed): readers'
 * favorites and recently added books, read on the server.
 */
export async function RecentShelf({ locale }: { locale: UiLocale }) {
  const page = await loadDiscover({}, locale, { genres: false });
  const t = materializeData(page.messages, { locale });
  // Sign-in from a shelf control returns to the home page.
  const signInHref = signInPath(localizedPath('/', locale));
  const shelves = page.shelves.filter(shelf => shelf.spec.type === 'book' && !shelf.spec.term).slice(0, 2);
  return <Providers>
    <ReaderActionsProvider signedIn={page.signedIn} signInHref={signInHref} actingSubject={page.actingSubject}
      seed={page.readerSeed}>
      <div className="grid gap-10">
        {shelves.map(shelf => <DiscoverShelf key={shelf.spec.key} mode="row" scope={{ kind: 'global' }}
          heading={{ title: shelfTitle(shelf, t), seeAll: { href: discoverHref({ scope: { kind: 'global' }, context: null,
            type: 'book', term: null }) } }}
          query={shelf.query} initial={shelf.initial} signInHref={signInHref} avatarQuery={page.avatarQuery}
          locale={locale} messages={page.messages} />)}
      </div>
    </ReaderActionsProvider>
  </Providers>;
}
