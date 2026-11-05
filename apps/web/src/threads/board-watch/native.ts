import type {
  BoardWatchCommand,
  BoardWatchCommandResult,
  BoardWatchNative,
  BoardWatchReadRequest,
  BoardWatchReadResult,
} from './contract';

export type BoardWatchTransport = Readonly<{
  readBoardWatchPage(input: {
    data: { boardId: string; accountId: string };
    headers: HeadersInit;
  }): Promise<BoardWatchReadResult>;
  setBoardWatch(input: {
    data: {
      boardId: string;
      accountId: string;
      watching: boolean;
      expectedRevision: number;
      idempotencyKey: string;
    };
    headers: HeadersInit;
  }): Promise<BoardWatchCommandResult>;
}>;

function current(owner: BoardWatchReadRequest): boolean {
  return typeof window !== 'undefined' && owner.csrfToken.length > 0 && (owner.isCurrent?.() ?? true);
}

/** Each operation keeps the reader's original session proof and checks its Board page visit before dispatch. */
export function createBoardWatchNative(
  load: () => Promise<BoardWatchTransport> = () => import('./transport'),
): BoardWatchNative {
  return Object.freeze({
    async read(request: BoardWatchReadRequest): Promise<BoardWatchReadResult> {
      if (!current(request)) return { kind: 'access-lost' };
      const transport = await load();
      if (!current(request)) return { kind: 'access-lost' };
      return transport.readBoardWatchPage({
        data: { boardId: request.boardId, accountId: request.accountId },
        headers: { 'X-CSRF-Token': request.csrfToken },
      });
    },
    async set(command: BoardWatchCommand): Promise<BoardWatchCommandResult> {
      if (!current(command)) return { kind: 'refused', reason: 'access-lost' };
      const transport = await load();
      if (!current(command)) return { kind: 'refused', reason: 'access-lost' };
      return transport.setBoardWatch({
        data: {
          boardId: command.boardId,
          accountId: command.accountId,
          watching: command.watching,
          expectedRevision: command.expectedRevision,
          idempotencyKey: command.idempotencyKey,
        },
        headers: { 'X-CSRF-Token': command.csrfToken },
      });
    },
  });
}

export const boardWatchNative = createBoardWatchNative();
