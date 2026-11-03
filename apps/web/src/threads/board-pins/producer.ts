import type {
  BoardPinBoardQuery,
  BoardPinBoardRead,
  BoardPinCommand,
  BoardPinCommandResult,
  BoardPinProducer,
  BoardPinReadResult,
} from './contract';

/** Production caller. Native listing capability is still absent, so readPage stays a decorator seam. */
export const productionBoardPinProducer: BoardPinProducer = Object.freeze({
  async readPage(): Promise<BoardPinReadResult> {
    return { state: 'unavailable' };
  },
  async readBoard(query: BoardPinBoardQuery): Promise<BoardPinBoardRead> {
    const { readBoardPinBoard } = await import('./server');
    return readBoardPinBoard({
      data: {
        boardId: query.boardId,
        ...(query.sort ? { sort: query.sort } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
      },
    });
  },
  async change(command: BoardPinCommand): Promise<BoardPinCommandResult> {
    const { changeBoardPin } = await import('./server');
    return changeBoardPin({
      data: {
        boardId: command.boardId,
        threadId: command.threadId,
        action: command.action,
        key: command.key,
      },
      headers: { 'X-CSRF-Token': command.sender.csrfToken },
    });
  },
});
