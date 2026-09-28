import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ChapterEditor } from '../../../../../../../../features/studio/chapter-editor.tsx';
import { readStudioChapter, readWorkHeader } from '../../../../../../../../features/studio/read.ts';
import { studioAgent } from '../../../../../../../../features/studio/route.ts';
import { languageTag, uuid } from '../../../../../../../../features/studio/types.ts';
import { WriteUnavailable } from '../../../../../../../../features/studio/write-states.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.chapterLabel, robots: { index: false } };
}

/**
 * One chapter to write, in its Book's language: at Main's draft head when Main
 * lets this Agent read it, else at the revision the address pins (Studio
 * keeps it current after every save).
 */
export default async function ChapterPage({ params, searchParams }: {
  params: Promise<{ agent: string; work: string; chapter: string }>;
  searchParams: Promise<{ revision?: string; language?: string }>;
}) {
  const [{ agent: segment, work, chapter }, query] = await Promise.all([params, searchParams]);
  if (!uuid.test(work) || !uuid.test(chapter)) notFound();
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  const revision = typeof query.revision === 'string' && uuid.test(query.revision) ? query.revision : null;
  // The chapter list names the Book's language; an address without one lets the chapter's own text decide.
  const language = typeof query.language === 'string' && languageTag.test(query.language) ? query.language : null;
  const [book, opened, messages] = await Promise.all([readWorkHeader(agent.iri, work, locale),
    readStudioChapter(agent.iri, chapter, revision, locale, language), getMessages('studio', locale)]);
  if (!book.ok) return <WriteUnavailable agent={agent} failure={book.failure} locale={locale} messages={messages} />;
  if (!opened.ok) {
    return <WriteUnavailable agent={agent} failure={opened.failure} work={book.data.id} locale={locale} messages={messages} />;
  }
  return <ChapterEditor key={opened.data.head ?? 'new'} agent={agent}
    book={{ id: book.data.id, title: { value: book.data.title.value, language: book.data.title.language } }}
    chapter={opened.data} locale={locale} messages={messages} />;
}
