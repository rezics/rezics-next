import { resourceHref, type AddressTarget } from '../../../../features/address/path.ts';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { localizedPath } from '../../../../i18n/locale.ts';
import { getMessages, requestLocale } from '../../../../i18n/server.ts';
import { EntityPage } from '../../../../features/entity-page/entity-page.tsx';
import { entityMetadata } from '../../../../features/entity-page/metadata.ts';
import { readEntityEntry, readEntityProjection } from '../../../../features/entity-page/read.ts';
import { readPublicCollectionPage } from '../../../../features/work-levels/read.ts';
import { PublicCollectionPage } from '../../../../features/work-levels/connections.tsx';
import { copyOf } from '../../../../features/entity-page/messages.ts';
import { PageContainer } from '../../../../features/shell/page.tsx';
import { RegionFailure } from '../../../../features/work-page/region.tsx';
import Link from '../../../../features/shell/localized-link.tsx';
import { parseEntityCursors, parseEntityRef } from '../../../../features/entity-page/route.ts';
import { pageUrl, representationPath } from '../../../../features/seo/address.ts';
import { parseContinuity } from '../../../../features/wiki/continuity.ts';
import { mainPosition, parsePosition } from '../../../../features/wiki/position.ts';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const id = parseEntityRef(ref);
  const entry = id ? await readEntityEntry(id, mainPosition(parsePosition(query))) : null;
  // A Collection has a members destination; metadata must not ask for an entity page either.
  const [metadata, page] = await Promise.all([
    entry && !entry.ok
      ? { title: entry.failure === 'missing' ? copyOf(locale).notFoundTitle : copyOf(locale).pageUnavailableTitle,
        robots: { index: false } } satisfies Metadata
      : entry?.ok && entry.data.type === 'collection'
      ? { title: entry.data.name.value, robots: { index: false } } satisfies Metadata
      : entityMetadata(ref, query, locale),
    pageUrl(),
  ]);
  return { ...metadata, ...(page ? { alternates: { canonical: page.origin + representationPath(page) } } : {}) };
}

/**
 * `/e/{ref}`: any admitted resource that has no host of its own — a release, a
 * chapter, a character, a resource of a type nobody registered. A Work keeps
 * its `/w` host, so its address does not split in two.
 */
export default async function EntityRoute({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const id = parseEntityRef(ref);
  const cursors = parseEntityCursors(query);
  if (!id || !cursors) notFound();
  const position = mainPosition(parsePosition(query));
  const entry = await readEntityEntry(id, position);
  if (!entry.ok) {
    if (entry.failure === 'missing') notFound();
    const messages = await getMessages('workPage', locale), t = copyOf(locale);
    return <PageContainer>
      <RegionFailure title={t.pageUnavailableTitle} failure={entry.failure} messages={messages} />
      <Link href="/discover" className="underline underline-offset-4">{t.search}</Link>
    </PageContainer>;
  }
  if (entry.ok && entry.data.type === 'collection') {
    const after = query.after, parent = query.parent;
    if (Array.isArray(after) || after && after.length > 2048 || Array.isArray(parent) ||
      parent && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(parent)) notFound();
    const [page, messages, url] = await Promise.all([
      readPublicCollectionPage(id, { after, parent, position }), getMessages('workPage', locale), pageUrl(),
    ]);
    if (!page.ok && page.failure === 'missing') notFound();
    const fallback = new URL(localizedPath(resourceHref('/e/', entry.data.address as AddressTarget), locale), 'https://rezics.com');
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) fallback.searchParams.append(key, item);
    }
    return <PublicCollectionPage summary={entry.data} page={page} locale={locale} messages={messages}
      currentUrl={(url ?? fallback).pathname + (url ?? fallback).search} />;
  }
  const realm = typeof query.realm === 'string' ? parseEntityRef(query.realm) : null;
  const ratingScope = query.scope === 'realm' && realm
    ? { scope: 'realm' as const, realm: `https://rezics.com/id/${realm}` } : { scope: 'global' as const };
  const projection = await readEntityProjection(id, position);
  if (projection.ok && projection.data.target.base === 'work') {
    const summary = projection.data.summary;
    const address = 'address' in summary ? summary.address as AddressTarget : id;
    permanentRedirect(localizedPath(resourceHref('/w/', address), locale));
  }
  // The continuity is off unless the address carries one: nothing is hidden until someone asks.
  return <EntityPage resource={id} locale={locale} cursors={cursors} position={position} ratingScope={ratingScope}
    continuity={parseContinuity(query)} continuitySwitch />;
}
