import { RecentShelf } from '../../features/discover/recent-shelf.tsx';
import { HomePage } from '../../features/home/home-page.tsx';
import { getMessages, requestLocale } from '../../i18n/server.ts';

export default async function Home() {
  const locale = await requestLocale();
  const messages = await getMessages('home', locale);
  return <HomePage messages={messages} shelf={<RecentShelf locale={locale} />} />;
}
