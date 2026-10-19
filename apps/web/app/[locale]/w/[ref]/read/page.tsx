import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { workPageMetadata, workTitle } from '../../../../../features/seo/work.ts';
import { BooksLanguageRecordedView } from '../../../../../features/work-page/books-language-recorded-page.tsx';
import { parseReaderSettings, READER_COOKIE } from '../../../../../features/work-page/reader-settings.ts';
import { loadWork, readBooksLanguagePage, readText, resolveWork } from '../../../../../features/work-page/read.ts';
import { parseReaderLanguage, parseWorkRef } from '../../../../../features/work-page/route.ts';
import { WorkUnavailable } from '../../../../../features/work-page/work-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, { t }] = await Promise.all([resolveWork(ref, locale), getTranslation('workPage', [locale])]);
  if (work.kind === 'missing') return { title: t.notFoundTitle };
  if (work.kind === 'unavailable') return { title: t.unavailableTitle, robots: { index: false } };
  if (work.kind === 'moved') return {};
  const language = parseReaderLanguage(query);
  const text = language === null ? null
    : await readText(work.header.mainVersion, language ?? work.header.selectedLanguage ?? undefined);
  if (!text?.ok) {
    const title = !text || text.failure === 'missing' ? t.textNotFoundTitle : t.textUnavailableTitle;
    return { title: await workTitle(work, title), robots: { index: false } };
  }
  return { title: await workTitle(work), ...await workPageMetadata(work, { tab: 'text' }, query, locale) };
}

// A Work with no chapters is read as its one selected text, outside the Work frame like a chapter.
export default async function TextPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const language = parseReaderLanguage(query);
  if (!parseWorkRef(ref)) notFound();
  const [work, messages, jar] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale), cookies()]);
  if (!work.ok) return <WorkUnavailable messages={messages} />;
  const page = await readBooksLanguagePage(work.id, work.header, language);
  if (page.kind === 'work-missing') notFound();
  const settings = parseReaderSettings(jar.get(READER_COOKIE)?.value && decodeURIComponent(jar.get(READER_COOKIE)!.value));
  return <BooksLanguageRecordedView
    reading={page.reading}
    workRef={ref} settings={settings} actingSubject={page.actingSubject} locale={locale} messages={messages}
    linkLanguage={language ?? undefined} />;
}
