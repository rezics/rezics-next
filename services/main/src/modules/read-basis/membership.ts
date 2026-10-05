import { decodeReadCursor, encodeReadCursor, WorkReadExpired,
  type ReadPosition } from '../work/read-session.ts';
import { READ_BASIS_RETENTION_MS } from './retention.ts';

/** These owners retain membership through revisions, rather than a graph copy.
 * Every page must still check current disclosure and close its owner revision fence. */
export const retainedMembershipFamilies = {
  'home-feed-v1': { owner: 'Access', revisions: ['population', 'following', 'target', 'personal'] },
  'realm-threads-v1': { owner: 'Access', revisions: ['population', 'history-admission'] },
} as const;

/** A registered family keeps the first page's deadline across every continuation.
 * The graph epoch remains a recovery fence; only its sequence may advance.
 * Encoding/decoding is bounded by the 2048-byte cursor limit and adds no owner I/O. */
export function retainedMembershipBasis(family: keyof typeof retainedMembershipFamilies,
  token: string | undefined, binding: readonly unknown[], position: ReadPosition) {
  if (binding[0] !== family) throw new Error('Retained membership family differs from cursor binding');
  const cursor = decodeReadCursor(token, binding, position, true);
  if (cursor && cursor.expiresAt === undefined) {
    throw new WorkReadExpired('Read basis has no retention deadline; restart from the first page');
  }
  const expiresAt = cursor?.expiresAt ?? Date.now() + READ_BASIS_RETENTION_MS;
  const assertLive = () => {
    if (expiresAt <= Date.now()) {
      throw new WorkReadExpired('Read basis expired; restart from the first page');
    }
  };
  return { cursor, assertLive, encode: (after: string, order: string) => {
    assertLive();
    return encodeReadCursor(binding, position, after, order, expiresAt);
  } };
}
