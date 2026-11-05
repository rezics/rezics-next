import type { FollowWriteInput, FollowWriteResult } from './follow-records';

type FollowSender = (input: FollowWriteInput, credential: string) => Promise<FollowWriteResult>;

/** One target's command identity, independent of refreshed labels, rows and reader keys. */
export function createFollowIntent() {
  let current: FollowWriteInput | null = null;
  let seeded = false;
  let conflicted = false;
  let sender: { credential: string; send: FollowSender } | null = null;

  return {
    get current() {
      return current;
    },
    get conflicted() {
      return conflicted;
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
      conflicted = false;
      // A server-issued key seeds one intent only. Even if its rendered prop never
      // changes, a confirmed command cannot lend that key to a later action.
      seeded = true;
      return current;
    },
    dispatch(
      input: FollowWriteInput,
      credential: () => string | null,
      send: FollowSender,
    ): Promise<FollowWriteResult> | null {
      if (!sender) {
        const captured = credential();
        if (!captured) return null;
        sender = { credential: captured, send };
      }
      return sender.send(input, sender.credential);
    },
    markConflicted(input: FollowWriteInput) {
      if (current === input) conflicted = true;
    },
    confirm(input: FollowWriteInput) {
      // Only the corresponding result can retire this intent. Late results from
      // an older dispatch must not clear a newer request's recovery identity.
      if (current === input) {
        current = null;
        conflicted = false;
        sender = null;
      }
    },
    reject(input: FollowWriteInput) {
      // Only deliberate recovery from definitive rejection may discard an intent.
      // An unavailable response must retain the original command for exact retry.
      if (current === input) {
        current = null;
        conflicted = false;
        sender = null;
      }
    },
  };
}

export type FollowIntentOwner = ReturnType<typeof createFollowIntent>;
