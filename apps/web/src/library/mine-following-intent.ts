import type { FollowWriteInput } from './follow-records';

/** One mounted target's request identity, independent of refreshed labels and reader keys. */
export function createFollowIntent() {
  let current: FollowWriteInput | null = null;
  let seeded = false;

  return {
    get current() {
      return current;
    },
    begin(targetId: string, following: boolean, seed?: string): FollowWriteInput {
      // Uncertainty retains the whole command, including its direction. A fresh read
      // cannot turn a retry into the opposite operation or supply it with a new key.
      if (current) return current;
      current = {
        targetId,
        following,
        idempotencyKey: !seeded && seed ? seed : crypto.randomUUID(),
      };
      // A server-issued key seeds one intent only. Even if its rendered prop never
      // changes, a confirmed command cannot lend that key to a later action.
      seeded = true;
      return current;
    },
    confirm(input: FollowWriteInput) {
      // Only the corresponding result can retire this intent. Late results from
      // an older dispatch must not clear a newer request's recovery identity.
      if (current === input) current = null;
    },
    reject(input: FollowWriteInput) {
      // Only deliberate recovery from definitive rejection may discard an intent.
      // An unavailable response must retain the original command for exact retry.
      if (current === input) current = null;
    },
  };
}
