import {
  collectionRenderPolicy,
  type CollectionPageResult,
  type CollectionPolicyPage,
  type CollectionReadProvenance,
} from './collection-load';
import { pageText } from '../features/pages/shared';
import { libraryTitleValue } from './title';
import { subjectHref } from '../subject/subject-href';
import type { HeadContext } from '../shell/head';
import { validatePublicOrigin } from '../shell/origin';

export type CollectionPublicPage = Pick<CollectionPageResult, 'id' | 'members'> &
  CollectionPolicyPage & { revision?: number; provenance?: CollectionReadProvenance };
export type CollectionPublicContext = Pick<HeadContext, 'origin' | 'locale'>;

/** The exact public mainEntity used by the head; native completeness is never inferred from members or counts. */
export function collectionPublicItemList(
  page: CollectionPublicPage,
  context: CollectionPublicContext,
  laterPage = false,
) {
  if (!collectionRenderPolicy(page, laterPage).completeItemList) return null;
  const origin = validatePublicOrigin(context.origin);
  const items = page.members.flatMap((member, index) =>
    member.subject
      ? [
          {
            '@type': 'ListItem',
            position: index + 1,
            url: new URL(
              subjectHref(
                {
                  id: member.subject.id,
                  label: pageText(libraryTitleValue(member.subject.label), context.locale).text,
                },
                context.locale,
              ).href,
              origin,
            ).href,
          },
        ]
      : [],
  );
  return {
    '@type': 'ItemList',
    numberOfItems: items.length,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    itemListElement: items,
  };
}

/** A standalone document contains only the already disclosed ItemList, with the head's script escaping. */
export function collectionPublicDocument(
  page: CollectionPublicPage,
  context: CollectionPublicContext,
  laterPage = false,
) {
  const itemList = collectionPublicItemList(page, context, laterPage);
  if (!itemList) return null;
  const id = page.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'public';
  return {
    filename: `collection-${id}.jsonld`,
    mediaType: 'application/ld+json',
    text: JSON.stringify({ '@context': 'https://schema.org', ...itemList }).replaceAll('<', '\\u003c'),
  };
}
