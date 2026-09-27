import type { Metadata } from 'next';
import { studioHref } from '../../../../features/studio/agent.ts';
import { readStudioHome } from '../../../../features/studio/read.ts';
import { studioAgent } from '../../../../features/studio/route.ts';
import { StudioHome } from '../../../../features/studio/studio-home.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.studio, robots: { index: false } };
}

export default async function StudioHomePage({ params, searchParams }: {
  params: Promise<{ agent: string }>; searchParams: Promise<{ cursor?: string }>;
}) {
  const [{ agent: segment }, { cursor }] = await Promise.all([params, searchParams]);
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  const valid = typeof cursor === 'string' && cursor.length <= 2048 ? cursor : undefined;
  const [home, messages] = await Promise.all([readStudioHome(agent.iri, locale, valid), getMessages('studio', locale)]);
  const next = home.texts.ok ? home.texts.data.nextCursor : null;
  return <StudioHome agent={agent} home={home} locale={locale} messages={messages}
    moreHref={next ? `${studioHref(agent)}?cursor=${encodeURIComponent(next)}` : null} />;
}
