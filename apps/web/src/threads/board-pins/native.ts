import type { KernelClient } from '@rezics/client';
import { MediaProblem } from '../../media/kernel.ts';
import { isPlatformClosedError } from '../../kernel/platform-closed.ts';
import type { SessionEnv } from '../../session/client.ts';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request.ts';
import { receiveBoardOpeningPage } from '../board-opening';
import { isInvalidBoardCursor, isMalformedBoardQuery } from '../board-reading';
import { boardPinAdviceInput, receiveBoardPinAdvice, type BoardPinAdviceResult } from './advice';
import {
  parseBoardPinBoard,
  parseBoardPinCommandResult,
  validBoardPinId,
  type BoardPinAction,
  type BoardPinBoardRead,
  type BoardPinCommand,
  type BoardPinCommandResult,
} from './contract';

/** Read selected advice through the generated callable, after binding the request to its live session. */
export async function readBoardPinAdviceRequest(
  input: {
    boardId: string;
    viewerId: string;
    selected: readonly { threadId: string; placeId: string; sourceRevisionId: string }[];
    pinRevision?: string;
  },
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  originConfigured: boolean,
): Promise<BoardPinAdviceResult> {
  const selection = boardPinAdviceInput(input.boardId, {
    selected: input.selected,
    ...(input.pinRevision === undefined ? {} : { pinRevision: input.pinRevision }),
  });
  if (!selection || !selection.pinRevision || !validBoardPinId(input.viewerId) || !originConfigured)
    return { state: 'unavailable' };
  try {
    await prepareSession(request, sessionEnv);
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.status === 403) return { state: 'denied' };
    if (error instanceof MediaProblem && error.problem.code === 'session_unavailable') return { state: 'unavailable' };
    if (isPlatformClosedError(error)) return { state: 'unavailable' };
    throw error;
  }
  const authorization = viewerCredential(request);
  const viewerId = sessionSubject(request);
  if (!authorization || viewerId !== input.viewerId) return { state: 'denied' };
  const query = { ...selection, boardId: input.boardId, viewerId, signal: request.signal };
  try {
    const result = await client.boards({ id: input.boardId })['pin-advice'].post(
      { selected: selection.selected.map((reference) => ({ ...reference })), pinRevision: selection.pinRevision },
      {
        headers: { authorization },
        fetch: { cache: 'no-store', redirect: 'manual', signal: request.signal },
      },
    );
    if (result.response === undefined) return { state: 'unavailable' };
    return receiveBoardPinAdvice(query, result.status, result.error ?? result.data);
  } catch (error) {
    if (isPlatformClosedError(error)) return { state: 'unavailable' };
    throw error;
  }
}

function readOutcome(boardId: string, status: number, body: unknown): BoardPinBoardRead {
  if (status === 401 || status === 403) return { state: 'denied' };
  if (isInvalidBoardCursor(status, body)) return { state: 'restart' };
  if (isMalformedBoardQuery(status, body)) return { state: 'malformed' };
  if (status === 200) return parseBoardPinBoard(boardId, body);
  return { state: 'unavailable' };
}

export async function readBoardPinBoardRequest(
  input: { boardId: string; sort?: 'active' | 'hot' | 'new'; cursor?: string; signal?: AbortSignal },
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  originConfigured: boolean,
): Promise<BoardPinBoardRead> {
  if (!validBoardPinId(input.boardId) || !originConfigured) return { state: 'unavailable' };
  try {
    await prepareSession(request, sessionEnv);
    const resource = client.boards({ id: input.boardId }).page;
    const authorization = viewerCredential(request);
    const query = { sort: input.sort ?? 'active', ...(input.cursor === undefined ? {} : { cursor: input.cursor }) };
    const result = await resource.get({
      ...(query ? { query } : {}),
      ...(authorization ? { headers: { authorization } } : {}),
      ...(input.signal ? { fetch: { signal: input.signal } } : {}),
    });
    if (result.error) return readOutcome(input.boardId, result.status, result.error);
    if (!result.data || result.data.board.id !== input.boardId) return { state: 'unavailable' };
    const opening = receiveBoardOpeningPage(result.data);
    const reading = parseBoardPinBoard(input.boardId, { ...opening.threads, authors: opening.authors });
    return reading.state === 'ready' ? { ...reading, opening } : reading;
  } catch (error) {
    if (isPlatformClosedError(error)) return { state: 'unavailable' };
    throw error;
  }
}

export async function changeBoardPinRequest(
  command: Pick<BoardPinCommand, 'boardId' | 'threadId' | 'action' | 'key'>,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  client: KernelClient,
  originConfigured: boolean,
): Promise<BoardPinCommandResult> {
  if (!validBoardPinId(command.boardId) || !validBoardPinId(command.threadId) || !originConfigured)
    return { state: 'unavailable' };
  const action: BoardPinAction = command.action;
  if (action !== 'pin' && action !== 'unpin') return { state: 'unavailable' };
  try {
    await prepareSession(request, sessionEnv);
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.status === 403) return { state: 'denied' };
    throw error;
  }
  const authorization = viewerCredential(request);
  if (!authorization) return { state: 'denied' };
  const resource = client.boards({ id: command.boardId }).threads({ threadId: command.threadId }).pin;
  // The installed command types only the idempotency key; the session credential still travels with the write.
  const headers = { authorization, 'idempotency-key': JSON.stringify(command.key) };
  let result: Awaited<ReturnType<typeof resource.post>>;
  try {
    result = await resource.post({ pinned: action === 'pin' }, { headers });
  } catch (error) {
    if (isPlatformClosedError(error)) return { state: 'unavailable' };
    return { state: 'unknown' };
  }
  if (result.response === undefined) return { state: 'unknown' };
  return parseBoardPinCommandResult(result.status, result.error ?? result.data, command);
}
