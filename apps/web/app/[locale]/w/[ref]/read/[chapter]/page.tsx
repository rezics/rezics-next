import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { workPageMetadata } from '../../../../../../features/seo/work.ts';
import { ChapterNotFound, ChapterReader, ChapterUnavailable } from '../../../../../../features/work-page/reader.tsx';
import { parseReaderSettings, READER_COOKIE } from '../../../../../../features/work-page/reader-settings.ts';
import { loadWork, postPlaceInBook, readChapter, readingAgent, readProgress, resolveWork }
  from '../../../../../../features/work-page/read.ts';
import { parseReaderLanguage, parseWorkRef } from '../../../../../../features/work-page/route.ts';
import { localizedPath } from '../../../../../../i18n/locale.ts';
import { WorkUnavailable } from '../../../../../../features/work-page/work-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string; chapter: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

const chapterId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref, chapter }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const language = parseReaderLanguage(query);
  const [work, { t }, read] = await Promise.all([resolveWork(ref, locale), getTranslation('workPage', [locale]),
    chapterId.test(chapter) && language !== null ? readChapter(chapter, language) : null]);
  if (work.kind !== 'work') return { title: t.notFoundTitle };
  // As in the page, a chapter address under another Work's ref is not this Work's chapter.
  if (!read?.ok || read.data.work !== work.header.id) {
    return { title: `${t.chapterNotFoundTitle} · ${work.header.title.value}`, robots: { index: false } };
  }
  return { title: work.header.title.value, ...await workPageMetadata(work, { tab: 'read', chapter }, query, locale) };
}

// The reader sits outside the Work frame: it keeps only a way back and the text.
export default async function ChapterPage({ params, searchParams }: Props) {
  const [{ ref, chapter }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const language = parseReaderLanguage(query);
  if (!parseWorkRef(ref)) notFound();
  const [work, messages, jar] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale), cookies()]);
  if (!work.ok) return <WorkUnavailable messages={messages} />;
  const read = chapterId.test(chapter) && language !== null ? await readChapter(chapter, language) : null;
  // The address of a chapter Post in this Book, such as a search result's, moves to its occurrence.
  if (read && !read.ok && read.failure === 'missing') {
    const place = await postPlaceInBook(chapter, work.id, locale, language ?? undefined);
    if (place) permanentRedirect(localizedPath(place, locale));
  }
  // A missing chapter, or a chapter address under another Work's ref, is not this Work's chapter.
  if (!read || (!read.ok && read.failure === 'missing') || (read.ok && read.data.work !== work.header.id)) {
    return <ChapterNotFound workRef={ref} messages={messages} />;
  }
  if (!read.ok) return <ChapterUnavailable workRef={ref} messages={messages} />;
  const [progress, agent] = await Promise.all([readProgress(read.data.progress), readingAgent()]);
  return <ChapterReader workRef={ref} work={work.header} chapter={read.data} language={language ?? undefined}
    settings={parseReaderSettings(jar.get(READER_COOKIE)?.value && decodeURIComponent(jar.get(READER_COOKIE)!.value))}
    progress={progress} actingSubject={agent.actingSubject} locale={locale} messages={messages} />;
}
