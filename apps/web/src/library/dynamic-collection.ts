import { m } from '../paraglide/messages.js';
import type { LibrarySubject } from './reads';
import type { CollectionListPresentations, CollectionPresentationData } from './collection-presentation';
import type { FilterDocument } from '@rezics/filter';
import type { CollectionFilterProperty } from './collection-filters';
import type { CollectionFilterParams } from './collection-filter-params';
import type { LibraryPinsRead } from './pins-read';
import type { MineCollection } from './mine-collections';
import type { CollectionMember } from './reads';

export type DynamicBuiltinKind = 'everything' | 'state' | 'liked' | (string & {});
export type DynamicCollectionRead = {
  id: string;
  curatorAccountId?: string;
  membershipKind: 'dynamic';
  builtinKind?: DynamicBuiltinKind;
  revision?: number;
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
  description: string | null;
  curator: { handle: string | null; displayName: string | null } | null;
  members: { subjectId?: string; subject: LibrarySubject | null; facts?: CollectionMember['facts'] }[];
  cursor?: string;
  next: string | null;
  preparing: boolean;
  retryAfterMs: number;
  unavailable: boolean;
  filterActive?: boolean;
  filter?: FilterDocument;
  filterIgnored?: string[];
  filterType?: string;
  filterStatus?: 'unsupported' | 'preparing' | 'failed';
  filterProperties?: CollectionFilterProperty[];
  filterParams?: CollectionFilterParams;
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
