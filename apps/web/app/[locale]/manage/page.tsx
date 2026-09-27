import type { Metadata } from 'next';
import { ManageHome } from '../../../features/manage/manage-home.tsx';
import { readQueue, readRealmHeader } from '../../../features/manage/read.ts';
import { manager, rememberedRealms } from '../../../features/manage/server.ts';
import { getMessages, getTranslation, requestLocale } from '../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.title, robots: { index: false } };
}

export default async function ManageRoute() {
  const locale = await requestLocale();
  const { agent, actingSubject, main, anonymous } = await manager(locale, '/manage');
  const [messages, realms] = await Promise.all([getMessages('manage', locale), rememberedRealms()]);
  const summaries = await Promise.all(realms.map(async realm => {
    const [header, queue] = await Promise.all([readRealmHeader(anonymous, realm, locale),
      readQueue(main, realm, { actingSubject, state: 'open', type: null })]);
    return { realm, header: header.ok ? header.data : null, queue };
  }));
  return <ManageHome agent={agent} realms={summaries} now={Date.now()} locale={locale} messages={messages} />;
}
