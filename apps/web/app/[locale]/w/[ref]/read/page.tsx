import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { workPageMetadata } from '../../../../../features/seo/work.ts';
import { TextNotFound, TextReader, TextUnavailable } from '../../../../../features/work-page/reader.tsx';
import { parseReaderSettings, READER_COOKIE } from '../../../../../features/work-page/reader-settings.ts';
import { loadWork, readingAgent, readText, resolveWork } from '../../../../../features/work-page/read.ts';
import { parseReaderLanguage, parseWorkRef } from '../../../../../features/work-page/route.ts';
import { WorkUnavailable } from '../../../../../features/work-page/work-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, { t }] = await Promise.all([resolveWork(ref, locale), getTranslation('workPage', [locale])]);
  if (work.kind !== 'work') return { title: t.notFoundTitle };
  const language = parseReaderLanguage(query);
  const text = language === null ? null
    : await readText(work.header.mainVersion, language ?? work.header.selectedLanguage ?? undefined);
  if (!text?.ok) return { title: `${t.textNotFoundTitle} · ${work.header.title.value}`, robots: { index: false } };
  return { title: work.header.title.value, ...await workPageMetadata(work, { tab: 'text' }, query, locale) };
}

// A Work with no chapters is read as its one selected text, outside the Work frame like a chapter.
export default async function TextPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const language = parseReaderLanguage(query);
  if (!parseWorkRef(ref)) notFound();
  const [work, messages, jar, agent] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale),
    cookies(), readingAgent()]);
  if (!work.ok) return <WorkUnavailable messages={messages} />;
  // The reader's own language when Main has a text in it; otherwise the text Main selects.
  const text = language === null ? null
    : await readText(work.header.mainVersion, language ?? work.header.selectedLanguage ?? undefined);
  if (!text || (!text.ok && text.failure === 'missing')) return <TextNotFound workRef={ref} messages={messages} />;
  if (!text.ok) return <TextUnavailable workRef={ref} messages={messages} />;
  return <TextReader workRef={ref} work={work.header} text={text.data} language={language ?? undefined}
    settings={parseReaderSettings(jar.get(READER_COOKIE)?.value && decodeURIComponent(jar.get(READER_COOKIE)!.value))}
    actingSubject={agent.actingSubject} locale={locale} messages={messages} />;
}
