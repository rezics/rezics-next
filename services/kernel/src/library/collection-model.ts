export type CollectionVisibility = 'private' | 'unlisted' | 'public';
export type CollectionState = 'active' | 'deleted';

/** Database projection for a Collection, including its partition and transaction identity. */
export type CollectionRow = {
  route: number;
  collectionId: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: CollectionVisibility;
  state: CollectionState;
  revision: number;
  memberCount: number;
  orderEpoch: number;
  createdAt: string;
  updatedAt: string;
  transactionId: string;
};

/** Collection view exposed to module callers. */
export type Collection = Omit<CollectionRow, 'route' | 'collectionId' | 'transactionId'> & { id: string };

export type CollectionDraft = {
  id: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: CollectionVisibility;
};

export type CollectionChanges = Pick<CollectionDraft, 'title' | 'description' | 'visibility'>;

/** Database projection for one ordered member. */
export type CollectionMemberRow = {
  route: number;
  collectionId: string;
  memberId: string;
  subjectId: string;
  note: string | null;
  ordinalKey: string;
  addedAt: string;
  transactionId: string;
  deletionId?: string | null;
  deletionRevision?: number | null;
  deletedAt?: string | null;
  purgeAfter?: string | null;
  deletedOrdinalKey?: string | null;
  memberRevision?: number;
};

/** Member view; subject IDs are deliberately not unique within a Collection. */
export type CollectionMember = Omit<CollectionMemberRow, 'route' | 'memberId' | 'transactionId'> & { id: string };

export type CollectionMemberDraft = {
  id: string;
  subjectId: string;
  note: string | null;
  ordinalKey: string;
};

export type MemberPosition = { kind: 'after'; memberId: string } | { kind: 'first' } | { kind: 'last' };

export type MemberNeighbors = { before: string | null; after: string | null };

export type MemberPage = {
  after: { ordinalKey: string; memberId: string } | null;
  limit: number;
};

export type MemberReordering = { memberId: string; ordinalKey: string };
