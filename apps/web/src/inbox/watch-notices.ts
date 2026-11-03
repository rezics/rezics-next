import type { KernelClient } from '@rezics/client';
import type { InboxNotice } from './inbox-read';

/** Local presentation categories. These are deliberately not native notification kind strings. */
export type WatchActivity = 'thread' | 'board';
export type WatchInboxNotice = InboxNotice & {
  watch: WatchActivity;
  threadId: string;
  postId: string | null;
  decisionId: null;
  reportId: null;
};

/**
 * Content's adapter must decode its released DTO, without inferring a kind from target fields.
 * Board activity refers to a new published thread; thread activity refers to a watched thread update.
 * No actor, text, destination or subscription state is stored by this port.
 */
export interface InboxWatchBinding {
  decode(value: unknown): WatchInboxNotice | null;
  /** A current owner read, under the same credential as the private Inbox page. */
  readThread(
    id: string,
    context: { client: KernelClient; authorization: string },
  ): Promise<{ id: string; title: string } | null>;
}

/** This base has no released watch DTO/kind registration. Unknown rows fail the whole native read. */
export const unavailableInboxWatch: InboxWatchBinding = {
  decode: () => null,
  readThread: async () => null,
};
