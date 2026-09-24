import { getTranslation, requestLocale } from '../i18n/server.ts';

export default async function HomePage() {
  const { data: messages } = await getTranslation('home', [await requestLocale()]);
  return <main className="page-width" style={{ paddingTop: 70 }}>
    <h1 className="page-title">{messages.title}</h1>
    <p className="muted" style={{ fontSize: 21, maxWidth: 740, lineHeight: 1.5 }}>
      {messages.description}
    </p>
    <p><a className="link-action" href="/search">{messages.explore}</a></p>
  </main>;
}
