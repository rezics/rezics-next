import type {
  BoardPinBoardQuery,
  BoardPinBoardRead,
  BoardPinCommand,
  BoardPinCommandResult,
  BoardPinProducer,
  BoardPinReadResult,
} from './contract';
import type { BoardPinAdviceQuery } from './advice';

/** Production caller. Selected advice uses the installed private server function and native callable. */
export const productionBoardPinProducer: BoardPinProducer = Object.freeze({
  async inspectSelected(query: BoardPinAdviceQuery) {
    const { readBoardPinAdvice } = await import('./server');
    return readBoardPinAdvice({
      data: {
        boardId: query.boardId,
        viewerId: query.viewerId,
        selected: query.selected,
        ...(query.pinRevision === undefined ? {} : { pinRevision: query.pinRevision }),
      },
      signal: query.signal,
    });
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
