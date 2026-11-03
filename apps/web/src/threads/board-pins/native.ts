import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed.ts';
import type { SessionEnv } from '../../session/client.ts';
import { prepareSession, viewerCredential } from '../../session/request.ts';
import { isInvalidBoardCursor, isMalformedBoardQuery } from '../board-reading';
import {
  parseBoardPinBoard,
  parseBoardPinCommandResult,
  validBoardPinId,
  type BoardPinAction,
  type BoardPinBoardRead,
  type BoardPinCommand,
  type BoardPinCommandResult,
} from './contract';

type NativeOptions = {
  query?: { cursor?: string; sort?: 'active' | 'hot' };
  headers?: { authorization?: string; 'idempotency-key'?: string };
  fetch?: { signal?: AbortSignal };
};

type NativeResult = Promise<{
  data?: unknown;
  error?: unknown;
  status: number;
}>;

type NativeBoardThreads = { get: (options: NativeOptions) => NativeResult };
type NativeBoardPin = { post: (body: { pinned: boolean }, options: NativeOptions) => NativeResult };

/** Bind generated Content methods when present. Do not invent a path or a successful body. */
export function nativeBoardThreads(client: KernelClient, boardId: string): NativeBoardThreads | undefined {
  const threads = client.boards({ id: boardId }).threads as unknown as NativeBoardThreads | undefined;
  if (!threads || typeof threads.get !== 'function') return undefined;
  return threads;
}

export function nativeBoardThreadPin(
  client: KernelClient,
  boardId: string,
  threadId: string,
): NativeBoardPin | undefined {
  const threads = client.boards({ id: boardId }).threads as unknown as
    | ((params: { threadId: string }) => { pin?: NativeBoardPin })
    | NativeBoardThreads;
  if (typeof threads !== 'function') return undefined;
  const pin = threads({ threadId }).pin;
  if (!pin || typeof pin.post !== 'function') return undefined;
  return pin;
}

function queryOf(sort: 'active' | 'hot' | 'new' | undefined, cursor: string | undefined): NativeOptions['query'] {
  const mapped: 'active' | 'hot' | undefined = sort === 'new' ? undefined : (sort ?? 'active');
  const query = {
    ...(cursor ? { cursor } : {}),
    ...(mapped ? { sort: mapped } : {}),
  };
  return Object.keys(query).length ? query : undefined;
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
    const resource = nativeBoardThreads(client, input.boardId);
    if (!resource) return { state: 'unavailable' };
    const authorization = viewerCredential(request);
    const query = queryOf(input.sort, input.cursor);
    const result = await resource.get({
      ...(query ? { query } : {}),
      ...(authorization ? { headers: { authorization } } : {}),
      ...(input.signal ? { fetch: { signal: input.signal } } : {}),
    });
    if (result.error) return readOutcome(input.boardId, result.status, result.error);
    return readOutcome(input.boardId, result.status, result.data);
  } catch (error) {
    if (isPlatformClosedError(error)) return { state: 'unavailable' };
    return { state: 'unavailable' };
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
    const authorization = viewerCredential(request);
    if (!authorization) return { state: 'denied' };
    const resource = nativeBoardThreadPin(client, command.boardId, command.threadId);
    if (!resource) return { state: 'unavailable' };
    const result = await resource.post(
      { pinned: action === 'pin' },
      { headers: { authorization, 'idempotency-key': JSON.stringify(command.key) } },
    );
    if (result.error) return parseBoardPinCommandResult(result.status, result.error, command);
    return parseBoardPinCommandResult(result.status, result.data, command);
  } catch (error) {
    if (isPlatformClosedError(error)) return { state: 'unavailable' };
    return { state: 'unknown' };
  }
}
