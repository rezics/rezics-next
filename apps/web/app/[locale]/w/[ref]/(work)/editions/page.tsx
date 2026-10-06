import type { Metadata } from 'next';
import { workTitle } from '../../../../../../features/seo/work.ts';
import { copyOf } from '../../../../../../features/work-levels/messages.ts';
import { EditionsPage } from '../../../../../../features/work-levels/pages.tsx';
import { parseEditionsQuery } from '../../../../../../features/work-levels/route.ts';
import { RegionFailure } from '../../../../../../features/work-page/region.tsx';
import { loadWork, resolveWork } from '../../../../../../features/work-page/read.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ ref }, locale] = await Promise.all([params, requestLocale()]);
  const [work, t] = await Promise.all([resolveWork(ref, locale), copyOf(locale)]);
  return { title: await workTitle(work, t.editions) };
}

/** `/w/{ref}/editions`: realizations by language and script, and the releases that carry them. */
export default async function WorkEditionsPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, pageMessages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  const parsed = parseEditionsQuery(query);
  if (!parsed) {
    return <RegionFailure title={copyOf(locale).editionsUnavailable} failure="invalid" messages={pageMessages} />;
  }
  return <EditionsPage workRef={ref} id={work.id} query={parsed} locale={locale} pageMessages={pageMessages} />;
}
