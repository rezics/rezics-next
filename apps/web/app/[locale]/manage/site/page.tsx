import type { Metadata } from 'next';
import { ManageFailure } from '../../../../features/manage/parts.tsx';
import { readAgents } from '../../../../features/manage/read.ts';
import { readSafetyPage } from '../../../../features/manage/safety-api.ts';
import { SafetyQueue } from '../../../../features/manage/safety-queue.tsx';
import { parseSafetyView, safetyHref } from '../../../../features/manage/safety-state.ts';
import { manager } from '../../../../features/manage/server.ts';
import { localizedPath } from '../../../../i18n/locale.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('manage', [await requestLocale()]);
  return { title: t.siteTitle, robots: { index: false } };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function SiteSafetyRoute({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const locale = await requestLocale();
  const view = parseSafetyView(params);
  const openCase = typeof params.case === 'string' && uuid.test(params.case) ? params.case : null;
  const { actingSubject, main, anonymous, signInHref } = await manager(locale, safetyHref(view));
  const now = Date.now();
  const [messages, page] = await Promise.all([getMessages('manage', locale), readSafetyPage(main, actingSubject, view, now)]);
  if (!page.ok) {
    return <ManageFailure failure={page.failure} locale={locale} messages={messages} signInHref={signInHref}
      retryHref={localizedPath(safetyHref(view), locale)} />;
  }
  const agents = await readAgents(anonymous, page.data.items.flatMap(item => item.claimedBy ?? []));
  const names = Object.fromEntries(Object.values(agents).flatMap(agent => agent.label ? [[agent.iri, agent.label]] : []));
  return <SafetyQueue key={JSON.stringify(view)} actingSubject={actingSubject} initial={page.data} view={view} now={now}
    openCase={openCase} names={names} locale={locale} messages={messages} />;
}
