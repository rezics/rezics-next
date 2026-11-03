export type ThreadWatchState = Readonly<{ watching: boolean; revision: string }>;

export type ThreadWatchReadRequest = Readonly<{
  threadId: string;
  viewerId: string;
  sessionStamp: string;
  fetch: Readonly<{ cache: 'no-store' }>;
}>;

export type ThreadWatchCommand = Readonly<{
  threadId: string;
  viewerId: string;
  sessionStamp: string;
  watching: boolean;
  expectedRevision: string;
  idempotencyKey: string;
}>;

export type ThreadWatchReadResult =
  | { kind: 'confirmed'; state: ThreadWatchState }
  | { kind: 'access-lost' }
  | { kind: 'unavailable' }
  | { kind: 'unknown' };

export type ThreadWatchCommandResult =
  | { kind: 'confirmed'; state: ThreadWatchState }
  | { kind: 'refused'; reason: 'access-lost' | 'conflict' | 'unavailable' }
  | { kind: 'unknown' };

export type ThreadWatchNative = {
  read(request: ThreadWatchReadRequest): Promise<ThreadWatchReadResult>;
  set(command: ThreadWatchCommand): Promise<ThreadWatchCommandResult>;
};

/** Content has not delivered a generated thread-watch API, so the installed route stays unavailable. */
export const threadWatchNative = Object.freeze<ThreadWatchNative>({
  async read() {
    return { kind: 'unavailable' };
  },
  async set() {
    return { kind: 'refused', reason: 'unavailable' };
  },
});
