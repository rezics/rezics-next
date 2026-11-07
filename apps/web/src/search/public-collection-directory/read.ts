import { localizedLabel } from '../results';
import {
  isCatalogueHit,
  readDiscovery,
  type DiscoveryHit,
  type PublicCollectionSummary as NativePublicCollectionSummary,
} from '../discovery';
import { publicCollectionDiscoveryRequest, publicCollectionKind } from './request';
import { publicCollectionCursorLimit, type PublicCollectionDirectoryAddress } from '../contracts/collection-directory';
import type { PublicCollectionDiscoveryState as DirectoryState } from '../../library/public-collection-discovery/read';

export type PublicCollectionSummary = Readonly<{
  id: string;
  title: string;
  titleLanguage?: string;
  description?: string;
  descriptionLanguage?: string;
  card?: NativePublicCollectionSummary['card'];
}>;

export type PublicCollectionDiscoveryState = DirectoryState<PublicCollectionSummary>;
export type PublicCollectionDiscoverySender = Parameters<typeof readDiscovery>[1];

function isCollectionHit(hit: DiscoveryHit) {
  return hit.key.kind === publicCollectionKind && (hit.summary.kind === 'collection' || isCatalogueHit(hit));
}

/** Admit the complete native page before projecting the disclosed Collection summaries. */
export async function readPublicCollectionPage(
  locale: string,
  address: PublicCollectionDirectoryAddress,
  send: PublicCollectionDiscoverySender,
): Promise<PublicCollectionDiscoveryState> {
  const { discovery } = await readDiscovery(publicCollectionDiscoveryRequest(locale, address), send);
  if (discovery.status !== 'ready') return { status: discovery.status };
  if (
    discovery.page.next !== null &&
    (!discovery.page.next.length || discovery.page.next.length > publicCollectionCursorLimit)
  )
    return { status: 'unavailable' };

  const collections: PublicCollectionSummary[] = [];
  for (const hit of discovery.page.hits) {
    if (!isCollectionHit(hit)) return { status: 'unavailable' };
    // Search already checks eligibility, source membership, card identity and the entire continuation.
    // Its native Collection summary is a separate branch from the Subject compatibility summary.
    if (hit.summary.kind === 'collection') {
      const summary = hit.summary.value;
      collections.push({
        id: hit.key.id,
        title: summary.title,
        ...(summary.description ? { description: summary.description } : {}),
        card: summary.card,
      });
      continue;
    }
    if (!isCatalogueHit(hit)) return { status: 'unavailable' };
    const summary = hit.summary.value;
    const title = localizedLabel(
      { ...(summary.label ? { [summary.label.language]: summary.label.value } : {}), ...(hit.labels ?? {}) },
      locale,
    );
    const description = localizedLabel(hit.descriptions ?? {}, locale);
    collections.push({
      id: hit.key.id,
      title: title.text,
      ...(title.lang ? { titleLanguage: title.lang } : {}),
      ...(description.text ? { description: description.text } : {}),
      ...(description.lang ? { descriptionLanguage: description.lang } : {}),
    });
  }

  return { status: 'ready', collections, next: discovery.page.next, asOf: discovery.page.as_of };
}
