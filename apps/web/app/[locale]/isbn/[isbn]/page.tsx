import { notFound, redirect } from 'next/navigation';
import { localizedPath } from '../../../../i18n/locale.ts';
import { readReleasesByIsbn } from '../../../../features/work-levels/read.ts';
import { parseIsbn, releaseHref } from '../../../../features/work-levels/route.ts';
import { copyOf } from '../../../../features/work-levels/messages.ts';
import { IsbnReleases } from '../../../../features/work-levels/pages.tsx';
import { ReleaseFailure } from '../../../../features/work-levels/release-page.tsx';
import { PageContainer } from '../../../../features/shell/page.tsx';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

type Props = { params: Promise<{ isbn: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * `/isbn/{isbn}`: Main resolves an ISBN to the release that carries it, and the
 * reader lands on that release (with its realization and Work); when several releases
 * carry the ISBN they are listed to choose from. A string that is no
 * ISBN is a 404 without asking Main; an ISBN no release carries is a 404 too.
 */
export default async function IsbnRoute({ params, searchParams }: Props) {
  const [{ isbn: segment }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const cursor = typeof query.cursor === 'string' && query.cursor.length <= 2048 ? query.cursor : undefined;
  const isbn = parseIsbn(segment);
  if (!isbn) notFound();
  const found = await readReleasesByIsbn(isbn, cursor);
  if (found.ok) {
    const [release, ...others] = found.data.items;
    if (!release) notFound();
    // One release is the answer. Several (or more on another page) are the reader's to choose from.
    if (!others.length && !found.data.nextCursor && !cursor) redirect(localizedPath(releaseHref(release.id), locale));
    return <PageContainer className="max-w-4xl">
      <IsbnReleases isbn={isbn} releases={found.data} cursor={Boolean(cursor)} locale={locale} />
    </PageContainer>;
  }
  if (found.failure === 'missing' || found.failure === 'invalid') notFound();
  return <PageContainer className="max-w-4xl">
    <ReleaseFailure failure={found.failure} messages={await getMessages('workPage', locale)} t={copyOf(locale)} />
  </PageContainer>;
}
