import type {
  BoardPinBoardQuery,
  BoardPinBoardRead,
  BoardPinCommand,
  BoardPinCommandResult,
  BoardPinProducer,
  BoardPinReadResult,
} from './contract';

/** Production caller. Selected advice stays closed until the official client publication is installed. */
export const productionBoardPinProducer: BoardPinProducer = Object.freeze({
  async inspectSelected() {
    // Keep the receiver closed until the official generated KernelClient publishes pin-advice.
    return { state: 'unavailable' } as const;
  },
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
