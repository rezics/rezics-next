import { type AddressTarget } from '../address/path.ts';
import type { Metadata } from 'next';
import type { UiLocale } from '../../i18n/define.ts';
import { localeAlternates, pageUrl } from '../seo/address.ts';
import { copyOf } from './messages.ts';
import { readEntityProjection } from './read.ts';
import { entityHref, parseEntityCursors, parseEntityRef } from './route.ts';
import { mainPosition, parsePosition } from '../wiki/position.ts';

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Title and search metadata for `/e/{ref}`, from the same projection the page
 * shows. Only a public resource is indexed, and a list cursor, an expiring
 * position rather than a page, is not. A missing or hidden resource is left
 * to the not-found view; vinext streams metadata, so it cannot answer 404 here.
 */
export async function entityMetadata(ref: string, query: SearchParams, locale: UiLocale): Promise<Metadata> {
  const id = parseEntityRef(ref);
  if (!id) return {};
  const projection = await readEntityProjection(id, mainPosition(parsePosition(query)));
  if (!projection.ok) return projection.failure === 'missing' ? { title: copyOf(locale).notFoundTitle }
    : { title: copyOf(locale).pageUnavailableTitle, robots: { index: false } };
  const { summary, target } = projection.data;
  if (summary.status !== 'available') return { title: copyOf(locale).notFoundTitle };
  const origin = (await pageUrl())?.origin ?? null;
  const address = 'address' in summary ? summary.address as AddressTarget : id;
  const alternates = origin ? localeAlternates(origin, entityHref(address), locale) : null;
  const cursors = parseEntityCursors(query);
  const paged = !cursors || Object.keys(cursors).length > 0 || query.position !== undefined || query.scope === 'realm';
  return { title: summary.name.value, ...(alternates ? { alternates } : {}),
    ...(target.disclosure !== 'public' || paged ? { robots: { index: false } } : {}) };
}
