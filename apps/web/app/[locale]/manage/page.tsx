import type { Metadata } from 'next';
import { ManageHome } from '../../../features/manage/manage-home.tsx';
import { readQueue, readRealmHeader, searchRealms } from '../../../features/manage/read.ts';
import { manager, rememberedRealms } from '../../../features/manage/server.ts';
import { getMessages, getTranslation, requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.title, robots: { index: false } };
}

export default async function ManageRoute({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [locale, params] = await Promise.all([requestLocale(), searchParams]);
  const query = typeof params.q === 'string' ? params.q.trim().slice(0, 80) : '';
  const { agent, actingSubject, main, anonymous } = await manager(locale, query ? `/manage?q=${encodeURIComponent(query)}` : '/manage');
  const [messages, realms, results] = await Promise.all([getMessages('manage', locale), rememberedRealms(),
    query ? searchRealms(anonymous, query, locale) : null]);
  const summaries = await Promise.all(realms.map(async realm => {
    const [header, queue] = await Promise.all([readRealmHeader(anonymous, realm, locale),
      readQueue(main, realm, { actingSubject, state: 'open', type: null })]);
    return { realm, header: header.ok ? header.data : null, queue };
  }));
  return <ManageHome agent={agent} realms={summaries} query={query} results={results} now={Date.now()} locale={locale}
    messages={messages} />;
}
