/** Local consumer seam only. Content has not released a typed management wire on this base. */
export type ManagedWatch = Readonly<{
  subscriptionId: string;
  kind: 'thread' | 'board';
  /** Released only by a current native target disclosure; absent targets remain removable. */
  target: Readonly<{ title: string; href: string }> | null;
}>;

export type WatchPage = Readonly<{ watches: readonly ManagedWatch[]; next: string | null }>;
export type WatchRead = { kind: 'page'; page: WatchPage } | { kind: 'unavailable' };
export type StopWatch = Readonly<{ subscriptionId: string; idempotencyKey: string }>;
export type StopWatchResult = { kind: 'removed' } | { kind: 'rejected' } | { kind: 'uncertain' };

export interface WatchManagementIO {
  read(input: Readonly<{ limit: number; cursor: string | null; signal: AbortSignal }>): Promise<WatchRead>;
  /** An adapter must send the original semantic input/key and the current Settings credential. */
  stop(input: StopWatch, credential: string): Promise<StopWatchResult>;
}

/** No guessed endpoint, additional subscription store or thread-page consumer. */
export const unavailableWatchManagement: WatchManagementIO = {
  read: async () => ({ kind: 'unavailable' }),
  stop: async () => ({ kind: 'uncertain' }),
};
