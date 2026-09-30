import type { Metadata } from 'next';
import { copyOf } from '../../../../../../features/work-levels/messages.ts';
import { ConnectionsPage } from '../../../../../../features/work-levels/pages.tsx';
import { parseConnectionsQuery } from '../../../../../../features/work-levels/route.ts';
import { RegionFailure } from '../../../../../../features/work-page/region.tsx';
import { loadWork, resolveWork } from '../../../../../../features/work-page/read.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ ref }, locale] = await Promise.all([params, requestLocale()]);
  const [work, t] = await Promise.all([resolveWork(ref, locale), copyOf(locale)]);
  return { title: work.kind === 'work' ? `${t.connections} · ${work.header.title.value}` : t.connections };
}

/** `/w/{ref}/connections`: the Work's parts, what it is part of, its franchises and its typed relations. */
export default async function WorkConnectionsPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, pageMessages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  const parsed = parseConnectionsQuery(query);
  if (!parsed) {
    return <RegionFailure title={copyOf(locale).connectionsUnavailable} failure="invalid" messages={pageMessages} />;
  }
  return <ConnectionsPage workRef={ref} id={work.id} query={parsed} locale={locale} pageMessages={pageMessages} />;
}
