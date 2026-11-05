import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client.ts';
import {
  isSlowModeInterval,
  validBoardId,
  type SlowModeChange,
  type SlowModeInterval,
  type SlowModeRead,
} from './contract';
import { changeBoardSlowModeRequest, readBoardSlowModeRequest } from './native';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function kernelOriginConfigured(): boolean {
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}

function validateBoard(input: unknown): { boardId: string } {
  if (!input || typeof input !== 'object' || !('boardId' in input) || !validBoardId(input.boardId))
    throw new Error('Invalid board');
  return { boardId: input.boardId };
}

function validateChange(input: unknown): {
  boardId: string;
  intervalSeconds: SlowModeInterval;
  idempotencyKey: string;
} {
  const { boardId } = validateBoard(input);
  if (
    !input ||
    typeof input !== 'object' ||
    !('intervalSeconds' in input) ||
    !isSlowModeInterval(input.intervalSeconds) ||
    !('idempotencyKey' in input) ||
    typeof input.idempotencyKey !== 'string' ||
    !uuid.test(input.idempotencyKey)
  )
    throw new Error('Invalid slow-mode command');
  return { boardId, intervalSeconds: input.intervalSeconds, idempotencyKey: input.idempotencyKey };
}

export const readBoardSlowMode = createServerFn({ method: 'GET' })
  .validator(validateBoard)
  .handler(async ({ data }): Promise<SlowModeRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return readBoardSlowModeRequest(
      data.boardId,
      getRequest(),
      env as Partial<SessionEnv>,
      kernelClient(),
      kernelOriginConfigured(),
    );
  });

export const changeBoardSlowMode = createServerFn({ method: 'POST' })
  .validator(validateChange)
  .handler(async ({ data }): Promise<SlowModeChange> => {
    setResponseHeader('cache-control', 'private, no-store');
    return changeBoardSlowModeRequest(
      data,
      getRequest(),
      env as Partial<SessionEnv>,
      kernelClient(),
      kernelOriginConfigured(),
    );
  });
