import { notFound, redirect } from 'next/navigation';
import { localizedPath } from '../../../i18n/locale.ts';
import { IdentifierReleases } from '../../../features/release-lookup/identifier-releases.tsx';
import { readReleasesByIdentifier } from '../../../features/release-lookup/read.ts';
import { parseReleaseIdentifier } from '../../../features/release-lookup/route.ts';
import { PageContainer } from '../../../features/shell/page.tsx';
import { copyOf } from '../../../features/work-levels/messages.ts';
import { releaseHref } from '../../../features/work-levels/route.ts';
import { ReleaseFailure } from '../../../features/work-levels/release-page.tsx';
import { getMessages, requestLocale } from '../../../i18n/server.ts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * `/release?provider=&identifier=`: Main resolves a store's own identifier (a provider-qualified digital entry) to
 * the release that carries it, and the reader lands on that release as `/isbn/{isbn}` does for an ISBN; several
 * releases are listed to choose from. A lookup missing either half is a 404 without asking Main, and so is one no
 * release carries.
 */
export default async function ReleaseLookupRoute({ searchParams }: Props) {
  const [query, locale] = await Promise.all([searchParams, requestLocale()]);
  const lookup = parseReleaseIdentifier(query);
  if (!lookup) notFound();
  const cursor = typeof query.cursor === 'string' && query.cursor.length <= 2048 ? query.cursor : undefined;
  const found = await readReleasesByIdentifier(lookup, cursor);
  const messages = await getMessages('workPage', locale);
  if (found.ok) {
    const [release, ...others] = found.data.items;
    if (!release) notFound();
    if (!others.length && !found.data.nextCursor && !cursor) redirect(localizedPath(releaseHref(release.id), locale));
    return <PageContainer className="max-w-4xl">
      <IdentifierReleases lookup={lookup} releases={found.data} cursor={Boolean(cursor)} locale={locale} messages={messages} />
    </PageContainer>;
  }
  if (found.failure === 'missing' || found.failure === 'invalid') notFound();
  return <PageContainer className="max-w-4xl">
    <ReleaseFailure failure={found.failure} messages={messages} t={copyOf(locale)} />
  </PageContainer>;
}
