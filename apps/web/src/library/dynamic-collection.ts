import { m } from '../paraglide/messages.js';
import type { LibrarySubject } from './reads';
import type { CollectionListPresentations, CollectionPresentationData } from './collection-presentation';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionFilterProperty } from './collection-filters';
import type { CollectionFilterParams } from './collection-filter-params';
import type { LibraryPinsRead } from './pins-read';
import type { MineCollection } from './mine-collections';
import type { CollectionMember } from './reads';
import type { CollectionViewerActions } from './collection-records';

export type DynamicBuiltinKind = 'everything' | 'state' | 'liked' | (string & {});
export type DynamicCollectionRead = {
  id: string;
  curatorAccountId?: string;
  membershipKind: 'dynamic';
  builtinKind?: DynamicBuiltinKind;
  revision?: number;
  visibility?: 'private' | 'public' | 'unlisted';
  builtinLabels?: Record<string, string>;
  title?: string | null;
  description?: string | null;
  curator?: { handle: string | null; displayName: string | null } | null;
};
export type CuratedCollectionRead = {
  id: string;
  membershipKind: 'curated';
  title: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  revision: number;
  curatorAccountId: string;
  visibility: 'private' | 'public' | 'unlisted';
  curator?: { handle: string | null; displayName: string | null } | null;
};
export type DynamicMemberRead = {
  kind: 'dynamic';
  subjectId: string;
  subject?: unknown | null;
  facts?: CollectionMember['facts'];
};
export type DynamicMembersPage = { members: DynamicMemberRead[]; next: string | null };
export type DynamicCollectionPage = CollectionPresentationData & {
  id: string;
  title: string;
  builtinKind?: DynamicBuiltinKind | undefined;
  revision?: number;
  curatorAccountId?: string;
  /** Present only in the authenticated owner's current detail read. */
  visibility?: 'private' | 'public' | 'unlisted' | null;
  /** Current resource actions from the existing Collection action read. */
  viewerActions?: CollectionViewerActions;
  description: string | null;
  curator: { handle: string | null; displayName: string | null } | null;
  members: { subjectId?: string; subject: LibrarySubject | null; facts?: CollectionMember['facts'] }[];
  cursor?: string;
  next: string | null;
  preparing: boolean;
  retryAfterMs: number;
  unavailable: boolean;
  cursorRestarted?: boolean;
  filterActive?: boolean;
  filter?: FilterDocument;
  filterIgnored?: string[];
  filterType?: string;
  filterStatus?: 'unsupported' | 'preparing' | 'failed' | undefined;
  filterProperties?: CollectionFilterProperty[];
  filterParams?: CollectionFilterParams;
  filterReleaseKey?: string;
  pins?: LibraryPinsRead;
  navigationCollections?: MineCollection[];
  following?: boolean | null;
  typeRatios?: Record<string, string>;
  listPresentations?: CollectionListPresentations;
};

export function dynamicCollectionTitle(
  collection: Pick<DynamicCollectionRead, 'builtinKind' | 'builtinLabels' | 'title'>,
  locale: string,
): string {
  if (collection.title != null) return collection.title;
  if (collection.builtinKind === 'everything') return m.library_dynamic_everything({}, { locale: locale as never });
  if (collection.builtinKind === 'liked') return m.library_dynamic_liked({}, { locale: locale as never });
  if (collection.builtinKind === 'state')
    return collection.builtinLabels?.[locale] || m.library_other({}, { locale: locale as never });
  return m.library_other({}, { locale: locale as never });
}
