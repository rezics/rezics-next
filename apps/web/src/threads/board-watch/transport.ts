import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { readBoardWatchRequest, setBoardWatchRequest, validateBoardWatchRead, validateBoardWatchSet } from './request';

/** These are deliberate private browser operations; public Board loading stays on its existing cacheable route. */
export const readBoardWatchPage = createServerFn({ method: 'POST' })
  .validator(validateBoardWatchRead)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    return readBoardWatchRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient());
  });

export const setBoardWatch = createServerFn({ method: 'POST' })
  .validator(validateBoardWatchSet)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    return setBoardWatchRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient());
  });
