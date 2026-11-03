export type BoardPinAction = 'pin' | 'unpin';

/** Content supplies one disclosed pin state and only the commands currently allowed for each row. */
export type BoardPinThread = Readonly<{
  threadId: string;
  pinned: boolean;
  actions: readonly BoardPinAction[];
}>;

export type BoardPinReadResult =
  | Readonly<{
      state: 'ready';
      boardId: string;
      management: 'allowed' | 'denied';
      threads: readonly BoardPinThread[];
    }>
  | Readonly<{ state: 'denied' }>
  | Readonly<{ state: 'unavailable' }>;

export type BoardPinSender = Readonly<{ subject: string; csrfToken: string }>;

/** The same immutable envelope, credentials and idempotency key are retained for an explicit retry. */
export type BoardPinCommand = Readonly<{
  boardId: string;
  threadId: string;
  action: BoardPinAction;
  sender: BoardPinSender;
  key: string;
}>;

export type BoardPinCommandInput = Omit<BoardPinCommand, 'key'>;

export type BoardPinCommandResult =
  | Readonly<{ state: 'applied'; boardId: string; thread: BoardPinThread }>
  | Readonly<{ state: 'denied' | 'conflict' | 'unknown' | 'unavailable' }>;

export type BoardPinProducer = Readonly<{
  /** Read statuses for the exact ordinary feed page; no directory or second feed is requested. */
  readPage(input: {
    boardId: string;
    threadIds: readonly string[];
    signal: AbortSignal;
  }): Promise<BoardPinReadResult>;
  change(command: BoardPinCommand): Promise<BoardPinCommandResult>;
}>;

export type BoardPinFeedState =
  | Readonly<{ state: 'empty' }>
  | Readonly<{ state: 'preparing' }>
  | Readonly<{ state: 'denied' }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{
      state: 'ready';
      management: 'allowed' | 'denied';
      byThreadId: ReadonlyMap<string, BoardPinThread>;
    }>;

export type BoardPinRowStatus =
  | Readonly<{ state: 'submitting'; action: BoardPinAction }>
  | Readonly<{ state: 'applied'; action: BoardPinAction }>
  | Readonly<{ state: 'denied' | 'conflict' | 'unknown' | 'unavailable'; action: BoardPinAction }>;

export const unavailableBoardPinProducer: BoardPinProducer = Object.freeze({
  async readPage() {
    return { state: 'unavailable' } as const;
  },
  async change() {
    return { state: 'unavailable' } as const;
  },
});

/** Attach producer data to existing page rows without changing their order or inventing missing states. */
export function joinBoardPinPage(
  boardId: string,
  threadIds: readonly string[],
  result: BoardPinReadResult,
): BoardPinFeedState {
  if (threadIds.length === 0) return { state: 'empty' };
  if (result.state === 'denied' || result.state === 'unavailable') return result;
  if (result.boardId !== boardId || result.threads.length !== threadIds.length) return { state: 'unavailable' };

  const expected = new Set(threadIds);
  if (expected.size !== threadIds.length) return { state: 'unavailable' };
  const byThreadId = new Map<string, BoardPinThread>();
  for (const thread of result.threads) {
    if (
      !expected.has(thread.threadId) ||
      byThreadId.has(thread.threadId) ||
      (thread.pinned && thread.actions.includes('pin')) ||
      (!thread.pinned && thread.actions.includes('unpin')) ||
      (result.management === 'denied' && thread.actions.length > 0)
    )
      return { state: 'unavailable' };
    byThreadId.set(thread.threadId, thread);
  }
  if (threadIds.some((threadId) => !byThreadId.has(threadId))) return { state: 'unavailable' };
  return { state: 'ready', management: result.management, byThreadId };
}

/** Owns exact-command recovery for one mounted board/session visit. Retiring it never cancels a sent command. */
export class BoardPinCommandCaller {
  private readonly pending = new Map<string, BoardPinCommand>();
  private readonly busy = new Set<string>();
  private retired = false;

  constructor(
    private readonly producer: BoardPinProducer,
    private readonly isCurrent: () => boolean,
    private readonly onStatus: (threadId: string, status: BoardPinRowStatus, result?: BoardPinCommandResult) => void,
    private readonly makeKey: () => string = () => crypto.randomUUID(),
  ) {}

  start(input: BoardPinCommandInput): Promise<void> {
    if (this.retired || !this.isCurrent() || this.busy.has(input.threadId) || this.pending.has(input.threadId))
      return Promise.resolve();
    const command = Object.freeze({
      ...input,
      sender: Object.freeze({ ...input.sender }),
      key: this.makeKey(),
    });
    return this.execute(command);
  }

  retry(threadId: string): Promise<void> {
    const command = this.pending.get(threadId);
    if (!command || this.retired || !this.isCurrent() || this.busy.has(threadId)) return Promise.resolve();
    return this.execute(command);
  }

  retire(): void {
    this.retired = true;
    this.pending.clear();
    this.busy.clear();
  }

  private async execute(command: BoardPinCommand): Promise<void> {
    if (this.retired || !this.isCurrent() || this.busy.has(command.threadId)) return;
    this.busy.add(command.threadId);
    this.onStatus(command.threadId, { state: 'submitting', action: command.action });
    let result: BoardPinCommandResult;
    try {
      result = await this.producer.change(command);
    } catch {
      result = { state: 'unknown' };
    }
    this.busy.delete(command.threadId);
    if (this.retired || !this.isCurrent()) return;

    if (result.state === 'applied') {
      if (
        result.boardId !== command.boardId ||
        result.thread.threadId !== command.threadId ||
        result.thread.pinned !== (command.action === 'pin')
      )
        result = { state: 'conflict' };
    }

    if (result.state === 'unknown' || result.state === 'unavailable') this.pending.set(command.threadId, command);
    else this.pending.delete(command.threadId);
    const state = result.state === 'applied' ? 'applied' : result.state;
    this.onStatus(command.threadId, { state, action: command.action }, result);
  }
}
