import { HomePage } from '../features/home/home-page.tsx';
import { getMessages, requestLocale } from '../i18n/server.ts';

export default async function Home() {
  const messages = await getMessages('home', await requestLocale());
  return <HomePage messages={messages} />;
}
