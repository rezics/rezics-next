import type { Metadata } from 'next';
import { materializeData } from 'native-i18n';
import { notFound } from 'next/navigation';
import { AuthorUnavailable, AuthorWorksListPage } from '../../../../../../features/author/author-page.tsx';
import { authorName } from '../../../../../../features/author/facts.ts';
import { authorReader, readOpenLibraryAuthor, readOpenLibraryAuthorWorks, readReaderState }
  from '../../../../../../features/author/read.ts';
import { parseCursor, parseOpenLibraryAuthor } from '../../../../../../features/author/route.ts';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

type Props = { params: Promise<{ author: string }>; searchParams: Promise<{ cursor?: string | string[] }> };

const PAGE = 20;
// The header needs only the author; one Work keeps that read small.
const HEADER_WORKS = 1;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const key = parseOpenLibraryAuthor((await params).author);
  if (!key) return {};
  const locale = await requestLocale();
  const [author, messages] = await Promise.all([readOpenLibraryAuthor(key, locale, HEADER_WORKS),
    getMessages('author', locale)]);
  if (!author.ok) return {};
  const t = materializeData(messages, { locale });
  // Later pages repeat the first page's subject; only the first is a document to index.
  return { title: t.worksHeading({ name: authorName(author.data, t) }),
    ...(parseCursor((await searchParams).cursor) ? { robots: { index: false } } : {}) };
}

export default async function OpenLibraryAuthorWorksRoute({ params, searchParams }: Props) {
  const key = parseOpenLibraryAuthor((await params).author);
  if (!key) notFound();
  const [locale, query] = await Promise.all([requestLocale(), searchParams]);
  const cursor = parseCursor(query.cursor);
  const [author, works, messages, reader] = await Promise.all([readOpenLibraryAuthor(key, locale, HEADER_WORKS),
    readOpenLibraryAuthorWorks(key, locale, PAGE, cursor), getMessages('author', locale), authorReader()]);
  if (!author.ok) {
    if (author.failure === 'missing' || author.failure === 'invalid') notFound();
    return <AuthorUnavailable authorKey={key} locale={locale} messages={messages} />;
  }
  const seed = await readReaderState(works.ok ? works.data.items.map(item => item.id) : []);
  return <AuthorWorksListPage author={author.data} works={works} cursor={cursor} locale={locale} messages={messages}
    reader={{ signedIn: reader.signedIn, actingSubject: reader.actingSubject, avatarQuery: reader.avatarQuery, seed }} />;
}
