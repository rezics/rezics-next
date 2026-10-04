import { resourceHref, type AddressTarget } from '../../../../features/address/path.ts';
import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { localizedPath } from '../../../../i18n/locale.ts';
import { requestLocale } from '../../../../i18n/server.ts';
import { EntityPage } from '../../../../features/entity-page/entity-page.tsx';
import { entityMetadata } from '../../../../features/entity-page/metadata.ts';
import { readEntityProjection } from '../../../../features/entity-page/read.ts';
import { parseEntityCursors, parseEntityRef } from '../../../../features/entity-page/route.ts';
import { pageUrl, representationPath } from '../../../../features/seo/address.ts';
import { mainPosition, parsePosition } from '../../../../features/wiki/position.ts';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [metadata, page] = await Promise.all([entityMetadata(ref, query, locale), pageUrl()]);
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
  const realm = typeof query.realm === 'string' ? parseEntityRef(query.realm) : null;
  const ratingScope = query.scope === 'realm' && realm
    ? { scope: 'realm' as const, realm: `https://rezics.com/id/${realm}` } : { scope: 'global' as const };
  const projection = await readEntityProjection(id, position);
  if (projection.ok && projection.data.target.base === 'work') {
    const summary = projection.data.summary;
    const address = 'address' in summary ? summary.address as AddressTarget : id;
    permanentRedirect(localizedPath(resourceHref('/w/', address), locale));
  }
  return <EntityPage resource={id} locale={locale} cursors={cursors} position={position} ratingScope={ratingScope} />;
}
