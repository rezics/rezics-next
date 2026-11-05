import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  readThreadWatchRequest,
  setThreadWatchRequest,
  validateThreadWatch,
  validateThreadWatchSet,
} from './thread-watch-request';

// Deliberate browser calls only. POST server functions preserve the existing session/CSRF boundary;
// the generated native reader remains GET. Neither function participates in SSR query hydration.
export const readThreadWatch = createServerFn({ method: 'POST' })
  .validator(validateThreadWatch)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    return readThreadWatchRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient());
  });

export const setThreadWatch = createServerFn({ method: 'POST' })
  .validator(validateThreadWatchSet)
  .handler(async ({ data }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    return setThreadWatchRequest(data, getRequest(), env as Partial<SessionEnv>, kernelClient());
  });
