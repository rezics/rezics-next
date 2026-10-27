import type { PoolClient } from 'pg';
import type {
  Collection,
  CollectionChanges,
  CollectionDraft,
  CollectionMember,
  CollectionMemberDraft,
  MemberNeighbors,
  MemberPage,
  MemberPosition,
  MemberReordering,
  CollectionVisibility,
} from './collection-model.ts';
import collectionInsert from './collection-store-collection-insert.sql';
import collectionRead from './collection-store-collection-read.sql';
import collectionUpdate from './collection-store-collection-update.sql';
import collectionTombstone from './collection-store-collection-tombstone.sql';
import collectionDeletionRead from './collection-store-collection-deletion-read.sql';
import collectionRestore from './collection-store-collection-restore.sql';
import collectionListCurator from './collection-store-collection-list-curator.sql';
import memberInsert from './collection-store-collection-member-insert.sql';
import memberRead from './collection-store-collection-member-read.sql';
import memberNeighborsSql from './collection-store-collection-member-neighbors.sql';
import memberNote from './collection-store-collection-member-note.sql';
import memberMove from './collection-store-collection-member-move.sql';
import memberDelete from './collection-store-collection-member-delete.sql';
import membersList from './collection-store-collection-members-list.sql';
import membersRespace from './collection-store-collection-members-respace.sql';

type Client = Pick<PoolClient, 'query'>;
type WriteContext = { transactionId: string; time: string };
type CollectionResult = NonNullable<Awaited<ReturnType<typeof collectionRead.run>>>;
type MemberResult = NonNullable<Awaited<ReturnType<typeof memberRead.run>>>;

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function asCollection(row: CollectionResult): Collection {
  return {
    id: row.id,
    curatorAccountId: row.curatorAccountId,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    state: row.state,
    revision: row.revision,
    memberCount: row.memberCount,
    orderEpoch: row.orderEpoch,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function asMember(row: MemberResult): CollectionMember {
  return {
    collectionId: row.collectionId,
    id: row.id,
    subjectId: row.subjectId,
    note: row.note,
    ordinalKey: row.ordinalKey,
    addedAt: iso(row.addedAt),
  };
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
    throw new RangeError('Page limit must be an integer from 1 through 5000');
  }
}

function write(context: WriteContext) {
  return { transaction_id: context.transactionId, time: context.time };
}

export async function insertCollection(
  client: Client,
  route: number,
  collection: CollectionDraft,
  context: WriteContext,
): Promise<Collection> {
  const rows = await collectionInsert.run(queryClient(client), {
    route,
    id: collection.id,
    curator_account_id: collection.curatorAccountId,
    title: collection.title,
    description: collection.description,
    visibility: collection.visibility,
    ...write(context),
  });
  const row = rows[0];
  if (!row) throw new Error('Collection insert returned no row');
  return asCollection(row as CollectionResult);
}

export async function readCollection(client: Client, route: number, id: string): Promise<Collection | null> {
  const row = await collectionRead.run(queryClient(client), { route, id });
  return row ? asCollection(row) : null;
}

export async function updateCollection(
  client: Client,
  route: number,
  id: string,
  revision: number,
  changes: CollectionChanges,
  context: WriteContext,
): Promise<Collection | null> {
  const row = await collectionUpdate.run(queryClient(client), {
    route,
    id,
    revision,
    title: changes.title,
    description: changes.description,
    visibility: changes.visibility,
    ...write(context),
  });
  return row ? asCollection(row as CollectionResult) : null;
}

export async function tombstoneCollection(
  client: Client,
  route: number,
  id: string,
  context: WriteContext,
): Promise<Collection | null> {
  const [row] = await collectionTombstone.run(queryClient(client), { route, id, ...write(context) });
  return row ? asCollection(row) : null;
}

// Private source metadata; purge must serialize and recheck state, revision and stamp before destructive work.
export async function readCollectionDeletion(
  client: Client,
  route: number,
  id: string,
): Promise<{ revision: number; deletedAt: string | null; purgeAfter: string | null } | null> {
  const row = await collectionDeletionRead.run(queryClient(client), { route, id });
  return row
    ? {
        revision: row.revision,
        deletedAt: row.deletedAt === null ? null : iso(row.deletedAt),
        purgeAfter: row.purgeAfter === null ? null : iso(row.purgeAfter),
      }
    : null;
}

export async function restoreCollection(
  client: Client,
  route: number,
  id: string,
  expectedRevision: number,
  context: WriteContext,
): Promise<Collection | null> {
  const [row] = await collectionRestore.run(queryClient(client), {
    route,
    id,
    revision: expectedRevision,
    ...write(context),
  });
  return row ? asCollection(row) : null;
}

export async function listCuratorCollections(
  client: Client,
  route: number,
  curatorAccountId: string,
  page: { after: string | null; visibility: CollectionVisibility | null; limit: number },
): Promise<Collection[]> {
  assertLimit(page.limit);
  const rows = await collectionListCurator.run(queryClient(client), {
    route,
    curator_account_id: curatorAccountId,
    after: page.after,
    visibility: page.visibility,
    limit: page.limit,
  });
  return rows.map(asCollection);
}

export async function insertMember(
  client: Client,
  route: number,
  collectionId: string,
  member: CollectionMemberDraft,
  context: WriteContext,
): Promise<CollectionMember | null> {
  const rows = await memberInsert.run(queryClient(client), {
    route,
    collection_id: collectionId,
    member_id: member.id,
    subject_id: member.subjectId,
    note: member.note,
    ordinal_key: member.ordinalKey,
    ...write(context),
  });
  const row = rows[0];
  return row ? asMember(row) : null;
}

export async function readMember(
  client: Client,
  route: number,
  collectionId: string,
  memberId: string,
): Promise<CollectionMember | null> {
  const row = await memberRead.run(queryClient(client), { route, collection_id: collectionId, member_id: memberId });
  return row ? asMember(row) : null;
}

export async function memberNeighbors(
  client: Client,
  route: number,
  collectionId: string,
  position: MemberPosition,
): Promise<MemberNeighbors | null> {
  const row = await memberNeighborsSql.run(queryClient(client), {
    route,
    collection_id: collectionId,
    kind: position.kind,
    member_id: position.kind === 'after' ? position.memberId : null,
  });
  if (!row || !row.found) return null;
  return { before: row.beforeKey, after: row.afterKey };
}

export async function updateMemberNote(
  client: Client,
  route: number,
  collectionId: string,
  memberId: string,
  note: string | null,
  context: WriteContext,
): Promise<CollectionMember | null> {
  const row = await memberNote.run(queryClient(client), {
    route,
    collection_id: collectionId,
    member_id: memberId,
    note,
    transaction_id: context.transactionId,
  });
  return row ? asMember(row as MemberResult) : null;
}

export async function moveMember(
  client: Client,
  route: number,
  collectionId: string,
  memberId: string,
  ordinalKey: string,
  context: WriteContext,
): Promise<CollectionMember | null> {
  const row = await memberMove.run(queryClient(client), {
    route,
    collection_id: collectionId,
    member_id: memberId,
    ordinal_key: ordinalKey,
    transaction_id: context.transactionId,
  });
  return row ? asMember(row as MemberResult) : null;
}

export async function deleteMember(
  client: Client,
  route: number,
  collectionId: string,
  memberId: string,
  context: WriteContext,
): Promise<CollectionMember | null> {
  const rows = await memberDelete.run(queryClient(client), {
    route,
    collection_id: collectionId,
    member_id: memberId,
    ...write(context),
  });
  const row = rows[0];
  return row ? asMember(row) : null;
}

export async function listMembers(
  client: Client,
  route: number,
  collectionId: string,
  page: MemberPage,
): Promise<CollectionMember[]> {
  assertLimit(page.limit);
  const rows = await membersList.run(queryClient(client), {
    route,
    collection_id: collectionId,
    after_ordinal_key: page.after?.ordinalKey ?? null,
    after_member_id: page.after?.memberId ?? null,
    limit: page.limit,
  });
  return rows.map(asMember);
}

export async function respaceMembers(
  client: Client,
  route: number,
  collectionId: string,
  members: readonly MemberReordering[],
  context: WriteContext,
): Promise<number | null> {
  if (members.length > 5000) throw new RangeError('A Collection cannot have more than 5000 members');
  const memberIds = new Set<string>();
  const ordinalKeys = new Set<string>();
  for (const member of members) {
    if (memberIds.has(member.memberId)) throw new RangeError('Respace member IDs must be unique');
    if (ordinalKeys.has(member.ordinalKey)) throw new RangeError('Respace ordinal keys must be unique');
    memberIds.add(member.memberId);
    ordinalKeys.add(member.ordinalKey);
  }
  const input: (typeof membersRespace)['~reylo']['input'] = {
    route,
    collection_id: collectionId,
    items: members.map(({ memberId, ordinalKey }) => ({ member_id: memberId, ordinal_key: ordinalKey })),
    ...write(context),
  };
  const values = membersRespace.params.map((name) => {
    const value = input[name as keyof typeof input];
    return name === 'items' ? JSON.stringify(value) : value;
  });
  const { rows } = await client.query<(typeof membersRespace)['~reylo']['element']>(membersRespace.sql, values);
  return rows[0]?.orderEpoch ?? null;
}
