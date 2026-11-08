import type { LibraryCoverSummary } from './capabilities.ts';

/** Values shared by Library's public Collection card and its native producer. */
export type CollectionCurator =
  | Readonly<{ state: 'available'; id: string; label: string | null; destination: string | null }>
  | Readonly<{ state: 'unavailable'; reason: 'deidentified' | 'withheld' | 'native_projection' }>;

export type CollectionPreviewMember = Readonly<{
  id: string;
  subject: {
    id: string;
    type: string;
    types: string[];
    label: { value: string; language: string } | null;
  };
}>;

export type CollectionPreview =
  | Readonly<{ state: 'available'; members: readonly CollectionPreviewMember[]; partial: boolean; truncated: boolean }>
  | Readonly<{ state: 'empty' | 'withheld' | 'unavailable' }>;

export type CollectionDiscoveryContext = Readonly<{ curator: CollectionCurator; preview: CollectionPreview }>;

/** Serializable presentation fields. Native presentation inputs remain private to Library. */
export type CollectionPresentation = {
  presentationKind: string | null;
  presentationKindSource: 'mixed' | 'owner';
  cover: LibraryCoverSummary | null;
  coverSource: 'owner' | 'member' | 'none' | 'pending';
  coverMediaId?: string | null;
};

type PublicCollectionCard = Omit<CollectionPresentation, 'coverMediaId'> &
  CollectionDiscoveryContext &
  Readonly<{
    kind: 'collection';
    id: string;
    destination: `/collections/${string}`;
    title: string;
    description: string | null;
    visibility: 'public';
    revision: number;
    sourceGeneration: string;
  }>;

/** The exact current Library-owned card carried inside Search's public Collection summary. */
export type PublicCollectionDiscoverySummary = PublicCollectionCard &
  (
    | Readonly<{
        membershipKind: 'curated';
        memberCount: number;
        orderEpoch: number;
        createdAt: string;
        updatedAt: string;
      }>
    | Readonly<{ membershipKind: 'dynamic'; outputGeneration: string }>
  );
