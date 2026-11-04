import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client.ts';
import { validBoardPinId, type BoardPinAction, type BoardPinBoardRead, type BoardPinCommandResult } from './contract';
import { changeBoardPinRequest, readBoardPinBoardRequest } from './native';

function kernelOriginConfigured(): boolean {
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}

function validateBoardRead(input: unknown): { boardId: string; sort?: 'active' | 'hot' | 'new'; cursor?: string } {
  if (!input || typeof input !== 'object' || !('boardId' in input) || !validBoardPinId(input.boardId))
    throw new Error('Invalid board pin read');
  const sort =
    'sort' in input && (input.sort === 'active' || input.sort === 'hot' || input.sort === 'new')
      ? input.sort
      : undefined;
  const cursor = 'cursor' in input && typeof input.cursor === 'string' ? input.cursor : undefined;
  return { boardId: input.boardId, ...(sort ? { sort } : {}), ...(cursor ? { cursor } : {}) };
}

function validateChange(input: unknown): {
  boardId: string;
  threadId: string;
  action: BoardPinAction;
  key: string;
} {
  if (
    !input ||
    typeof input !== 'object' ||
    !('boardId' in input) ||
    !validBoardPinId(input.boardId) ||
    !('threadId' in input) ||
    !validBoardPinId(input.threadId) ||
    !('action' in input) ||
    (input.action !== 'pin' && input.action !== 'unpin') ||
    !('key' in input) ||
    typeof input.key !== 'string' ||
    !validBoardPinId(input.key)
  )
    throw new Error('Invalid board pin command');
  return { boardId: input.boardId, threadId: input.threadId, action: input.action, key: input.key };
}

export const readBoardPinBoard = createServerFn({ method: 'GET' })
  .validator(validateBoardRead)
  .handler(async ({ data }): Promise<BoardPinBoardRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readBoardPinBoardRequest(
      data,
      getRequest(),
      env as Partial<SessionEnv>,
      kernelClient(),
      kernelOriginConfigured(),
    );
  });

export const changeBoardPin = createServerFn({ method: 'POST' })
  .validator(validateChange)
  .handler(async ({ data }): Promise<BoardPinCommandResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return changeBoardPinRequest(
      data,
      getRequest(),
      env as Partial<SessionEnv>,
      kernelClient(),
      kernelOriginConfigured(),
    );
  });
