import { notFound, redirect } from 'next/navigation';
import { localizedPath } from '../../../../i18n/locale.ts';
import { readReleasesByIsbn } from '../../../../features/work-levels/read.ts';
import { parseIsbn, releaseHref } from '../../../../features/work-levels/route.ts';
import { copyOf } from '../../../../features/work-levels/messages.ts';
import { ReleaseFailure } from '../../../../features/work-levels/release-page.tsx';
import { PageContainer } from '../../../../features/shell/page.tsx';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';

type Props = { params: Promise<{ isbn: string }> };

/**
 * `/isbn/{isbn}`: Main resolves an ISBN to the release that carries it, and the
 * reader lands on that release (with its realization and Work). A string that is no
 * ISBN is a 404 without asking Main; an ISBN no release carries is a 404 too.
 */
export default async function IsbnRoute({ params }: Props) {
  const [{ isbn: segment }, locale] = await Promise.all([params, requestLocale()]);
  const isbn = parseIsbn(segment);
  if (!isbn) notFound();
  const found = await readReleasesByIsbn(isbn);
  if (found.ok) {
    const release = found.data.items[0];
    if (!release) notFound();
    redirect(localizedPath(releaseHref(release.id), locale));
  }
  if (found.failure === 'missing' || found.failure === 'invalid') notFound();
  return <PageContainer className="max-w-4xl">
    <ReleaseFailure failure={found.failure} messages={await getMessages('workPage', locale)} t={copyOf(locale)} />
  </PageContainer>;
}
