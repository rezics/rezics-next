import type { KernelClient } from '@rezics/client';
import type { RealmLink } from '../community/space';

export type ReviewBoardChoice = { id: string; title: string | null; realmId: string; realmName: string };

/** Reads review boards only from the signed-in reader's bounded list of Realms. */
export async function loadRealmReviewBoards(
  client: KernelClient,
  realms: readonly RealmLink[],
  authorization: string,
): Promise<ReviewBoardChoice[]> {
  const reads = await Promise.all(
    realms.map(async (realm) => {
      const choices: ReviewBoardChoice[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        const result = await client.realms({ realmId: realm.realmId }).boards.get({
          query: { limit: 100, ...(cursor ? { cursor } : {}) },
          headers: { authorization },
        });
        if (result.status === 404 || result.status === 403) return [];
        if (result.error || !result.data) throw new Error('Realm board read failed');
        choices.push(
          ...result.data.items
            .filter(
              (board) =>
                board.availability === 'available' && board.visibility !== 'taken_down' && board.purpose === 'reviews',
            )
            .map((board) => ({
              id: board.id,
              title: board.title,
              realmId: board.realmId ?? realm.realmId,
              realmName: realm.name,
            })),
        );
        const next = result.data.next;
        if (!next || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
      return choices;
    }),
  );
  return reads.flat();
}
