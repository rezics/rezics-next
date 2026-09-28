import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AuthorPage, AuthorUnavailable } from '../../../../../features/author/author-page.tsx';
import { authorJsonLd, authorMetadata } from '../../../../../features/author/metadata.ts';
import { authorReader, readAuthorFollow, readOpenLibraryAuthor, readReaderState }
  from '../../../../../features/author/read.ts';
import { parseOpenLibraryAuthor } from '../../../../../features/author/route.ts';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

type Props = { params: Promise<{ author: string }> };

// Goodreads lists ten of an author's books before "More books by …".
const OVERVIEW_WORKS = 10;

// Metadata reads the author directly and never throws notFound(): vinext
// streams metadata, so a 404 thrown there would answer 200. The page does.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const key = parseOpenLibraryAuthor((await params).author);
  if (!key) return {};
  const locale = await requestLocale();
  const [author, messages] = await Promise.all([readOpenLibraryAuthor(key, locale, OVERVIEW_WORKS),
    getMessages('author', locale)]);
  return author.ok ? authorMetadata(author.data, locale, messages) : {};
}

/**
 * `/authors/open-library/{OL…A}` for every Open Library author a public
 * REZICS Work credits; any other author, or an ID that is not one, is a 404.
 */
export default async function OpenLibraryAuthorRoute({ params }: Props) {
  const key = parseOpenLibraryAuthor((await params).author);
  if (!key) notFound();
  const locale = await requestLocale();
  const [author, messages, reader, follow] = await Promise.all([readOpenLibraryAuthor(key, locale, OVERVIEW_WORKS),
    getMessages('author', locale), authorReader(), readAuthorFollow(key, locale)]);
  if (!author.ok) {
    if (author.failure === 'missing' || author.failure === 'invalid') notFound();
    return <AuthorUnavailable authorKey={key} locale={locale} messages={messages} />;
  }
  const seed = await readReaderState(author.data.works.items.map(item => item.id));
  return <>
    {/* JSON-LD must be raw script text; authorJsonLd escapes `<` so it cannot close the element. */}
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: authorJsonLd(author.data, locale, messages) }} />
    <AuthorPage author={author.data} follow={follow} locale={locale} messages={messages}
      reader={{ signedIn: reader.signedIn, actingSubject: reader.actingSubject, avatarQuery: reader.avatarQuery, seed }} />
  </>;
}
