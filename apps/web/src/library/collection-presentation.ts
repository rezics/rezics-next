import type { KernelClient } from '@rezics/client';
import { pickText } from '@rezics/composition';
import type { Release } from '../subject/definitions';
import { getLocale } from '../paraglide/runtime.js';
import {
  defaultCoverRatio,
  listPresentationRatio,
  parseCoverRatio,
  parseListPresentation,
  type CoverRatio,
  type ListPresentation,
} from '@rezics/ui/cover';
import type { LibrarySubject } from './reads';

/** The member's own configuration wins; absent or retired Types share the portrait default. */
export function collectionMemberRatio(
  subject: Pick<LibrarySubject, 'type'> | null,
  typeRatios: Readonly<Record<string, string>> = {},
  presentations: CollectionListPresentations = {},
): CoverRatio {
  if (!subject) return defaultCoverRatio;
  const presentation = parseListPresentation(presentations[subject.type]);
  return presentation
    ? listPresentationRatio(presentation)
    : (parseCoverRatio(typeRatios[subject.type] ?? '') ?? defaultCoverRatio);
}

/** Reorder only loaded occurrences. A later page cannot claim the Collection's first position. */
export function reorderCollectionMembers<Member extends { id: string }>(
  members: readonly Member[],
  memberId: string,
  after: string | null,
  firstPage: boolean,
): Member[] {
  if (after === memberId || (!firstPage && (after === null || memberId === members[0]?.id))) return [...members];
  const moved = members.find((member) => member.id === memberId);
  if (!moved) return [...members];
  const remaining = members.filter((member) => member.id !== memberId);
  const position = after === null ? 0 : remaining.findIndex((member) => member.id === after) + 1;
  if (after !== null && position === 0) return [...members];
  return [...remaining.slice(0, position), moved, ...remaining.slice(position)];
}

type NativeCollection = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['collections']>['get']>>['data']
>['collection'];
export type CollectionPresentationData = Partial<
  Pick<NativeCollection, 'presentationKind' | 'cover' | 'coverSource'>
> & { presentationKindSource?: 'owner' | 'mixed' };
// The controller owns generated-client refresh; accept its older source union at this read boundary.
type CollectionPresentationInput = Omit<CollectionPresentationData, 'presentationKindSource'> & {
  presentationKindSource?: NativeCollection['presentationKindSource'] | 'mixed';
};
export type CollectionTypeOption = { id: string; label: string };
export type CollectionListPresentations = Readonly<Record<string, ListPresentation>>;

/** Keep the one shell filter protocol intact when following a native signed page cursor. */
export function collectionPageAddress(
  locale: string,
  id: string,
  cursor: string,
  search: Record<string, string | string[]> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (key !== 'type' && !/^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key)) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  params.set('cursor', cursor);
  return `/${locale}/collections/${encodeURIComponent(id)}?${params}`;
}

/** Copy only public presentation, never configured media identity or private editor data. */
export function collectionPresentationOf(collection: CollectionPresentationInput): CollectionPresentationData {
  const explicit = collection.presentationKindSource === 'owner';
  return {
    presentationKind: explicit ? (collection.presentationKind ?? null) : null,
    presentationKindSource: explicit ? 'owner' : 'mixed',
    ...(collection.coverSource === undefined ? {} : { coverSource: collection.coverSource }),
    ...(collection.cover ? { cover: collection.cover } : {}),
  };
}

export function readCollectionTypeOptions(release: Release): CollectionTypeOption[] {
  return Object.entries(release.types)
    .map(([id, type]) => ({
      id,
      label: type.labels ? pickText(type.labels, getLocale()).text || id : id,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
