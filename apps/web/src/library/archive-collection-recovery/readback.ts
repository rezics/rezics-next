import type { KernelClient } from '@rezics/client';

type CollectionEnvelope = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['collections']>['get']>>['data']
>['collection'];
type MemberPage = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['collections']>['members']['get']>>['data']>;
type CuratedMembers = Extract<MemberPage, { members: unknown[] }>;
type CuratedMember = Extract<CuratedMembers['members'][number], { id: string }>;

export const RECEIVING_COLLECTION_PAGE = 100;

export type ReceivingMemberReadback = {
  id: string;
  subjectId: string | null;
  note: string | null;
  addedAt: string;
};

export type ReceivingCollectionReadback = {
  id: string;
  title: string;
  visibility: 'private' | 'public' | 'unlisted' | null;
  memberCount: number;
  members: ReceivingMemberReadback[];
  next: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Project one native Collection reader page. Archive outcomes never invent membership or order. */
export function projectReceivingCollection(
  collection: CollectionEnvelope,
  page: MemberPage,
): ReceivingCollectionReadback | null {
  if (!record(collection) || typeof collection.id !== 'string' || typeof collection.title !== 'string') return null;
  if (!('memberCount' in collection) || typeof collection.memberCount !== 'number') return null;
  if (!record(page) || !('members' in page) || !Array.isArray(page.members)) return null;
  const members: ReceivingMemberReadback[] = [];
  for (const row of page.members) {
    if (!record(row) || typeof row.id !== 'string') return null;
    const member = row as CuratedMember;
    members.push({
      id: member.id,
      subjectId: 'subjectId' in member && typeof member.subjectId === 'string' ? member.subjectId : null,
      note: member.note,
      addedAt: member.addedAt,
    });
  }
  const visibility =
    'visibility' in collection &&
    (collection.visibility === 'private' || collection.visibility === 'public' || collection.visibility === 'unlisted')
      ? collection.visibility
      : null;
  return {
    id: collection.id,
    title: collection.title,
    visibility,
    memberCount: collection.memberCount,
    members,
    next: 'next' in page && typeof page.next === 'string' ? page.next : null,
  };
}
