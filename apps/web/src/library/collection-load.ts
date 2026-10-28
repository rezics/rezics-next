import type { KernelClient } from '@rezics/client';
import type { SessionEnv } from '../session/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { readCollectionFollow } from './collection-records';
import {
  libraryFullQuery,
  libraryListQuery,
  readLibraryResult,
  StaleCursorError,
  subjectOf,
  type CollectionPageData,
  type LibraryAccount,
} from './reads';

export type EditableCollectionPage = CollectionPageData & {
  /** The revision the page was read at; a revisioned write sends it back. */
  revision: number;
  /** The first member page, where a member can move to the top. */
  firstPage: boolean;
  /** The viewer's follow state, or null when the viewer cannot follow this collection. */
  following: boolean | null;
};

function accountOf(account: { handle: string | null; displayName: string | null } | null | undefined) {
  return account ? ({ handle: account.handle, displayName: account.displayName } satisfies LibraryAccount) : null;
}

/**
 * Reads one collection and one members page, with the viewer's credential when there is one so a curator sees their
 * private collection. A cursor the kernel no longer accepts restarts at the first page. A signed-in person who is not
 * the curator of a public collection also gets the follow state, in one more kernel read.
 */
export async function loadEditableCollectionPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string; cursor?: string },
  credentialMode: ReadCredentialMode = 'session',
): Promise<EditableCollectionPage> {
  let authorization: string | null = null;
  if (credentialMode === 'session') {
    // A session that cannot be read leaves the collection readable to everyone.
    const signedOut = await prepareSession(request, sessionEnv).then(
      (stale) => stale,
      () => true,
    );
    authorization = signedOut ? null : viewerCredential(request);
  }
  const viewer = authorization ? sessionSubject(request) : undefined;
  const headers = authorization ? { headers: { authorization } } : {};
  const readMembers = async (cursor?: string) =>
    readLibraryResult(
      await client.collections({ collectionId: input.id }).members.get({ query: libraryListQuery(cursor), ...headers }),
    );
  const [collection, first] = await Promise.all([
    client
      .collections({ collectionId: input.id })
      .get({ query: libraryFullQuery(), ...headers })
      .then((result) => readLibraryResult(result).collection),
    readMembers(input.cursor).then(
      (page) => ({ stale: false as const, page }),
      (error: unknown) => {
        if (error instanceof StaleCursorError) return { stale: true as const };
        throw error;
      },
    ),
  ]);
  const members = first.stale ? await readMembers() : first.page;
  const owner = viewer !== undefined && viewer === collection.curatorAccountId;
  const following =
    authorization && viewer !== undefined && !owner && collection.visibility === 'public'
      ? await readCollectionFollow(client, input.id, authorization)
      : null;
  return {
    id: collection.id,
    title: collection.title,
    description: collection.description,
    memberCount: collection.memberCount,
    updatedAt: collection.updatedAt,
    curator: accountOf(collection.curator),
    visibility: owner ? collection.visibility : null,
    members: members.members.map((member) => ({
      id: member.id,
      note: member.note,
      addedAt: member.addedAt,
      subject: subjectOf(member.subject),
    })),
    next: members.next,
    revision: collection.revision,
    firstPage: first.stale || input.cursor === undefined,
    following,
  };
}
