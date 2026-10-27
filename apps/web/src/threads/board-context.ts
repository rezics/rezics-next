import type { KernelClient } from '@rezics/client';

/** The Realm a board belongs to, named for the reader. */
export type BoardRealm = { id: string; title: string };

/**
 * The Realm identifier a board view carries: `null` for a board outside every Realm. It is read structurally, because
 * the generated client declarations are refreshed on their own schedule.
 */
export function boardRealmId(board: object): string | null {
  const realmId = (board as { realmId?: unknown }).realmId;
  return typeof realmId === 'string' ? realmId : null;
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
    return realm && realm.realmId === realmId && realm.title ? { id: realm.realmId, title: realm.title } : undefined;
  } catch {
    return undefined;
  }
}
