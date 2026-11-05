import type { KernelClient } from '@rezics/client';

/** The Realm a board belongs to, named for the reader. */
export type BoardRealm = {
  id: string;
  title: string;
  summary?: string;
  visibility?: 'public' | 'protected';
  state?: string;
};

/**
 * Only an explicitly Global board has no Realm. A failed optional Realm read does not change this identity.
 */
export function boardRealmId(board: { realmId: string | null }): string | null {
  return board.realmId;
}

/**
 * The Realm of a board for the line above a page title. A board without a Realm makes no read, and a Realm that
 * cannot be read is left out: the page does not depend on it.
 */
export async function readBoardRealm(
  client: KernelClient,
  realmId: string | null | undefined,
  authorization?: string | null,
): Promise<BoardRealm | undefined> {
  if (!realmId) return undefined;
  try {
    const result = await client.realms({ realmId }).get(authorization ? { headers: { authorization } } : {});
    const realm = result.error ? undefined : result.data?.realm;
    return realm && realm.realmId === realmId && realm.state === 'active' && realm.title
      ? {
          id: realm.realmId,
          title: realm.title,
          summary: realm.summary,
          visibility: realm.visibility,
          state: realm.state,
        }
      : undefined;
  } catch {
    return undefined;
  }
}
