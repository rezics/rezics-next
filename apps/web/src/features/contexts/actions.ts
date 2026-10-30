import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { MediaProblem } from '../../media/kernel';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { createContextApi } from './api';
import { directoryInput, parseAddress, parseCommand, type Failure } from './model';

async function viewer(): Promise<string | Failure> {
  setResponseHeader('cache-control', 'private, no-store');
  try {
    const request = getRequest();
    const stale = await prepareSession(request, env as Partial<SessionEnv>);
    return (!stale && viewerCredential(request)) || { kind: 'signed-out' };
  } catch (error) {
    return error instanceof MediaProblem
      ? { kind: error.problem.status === 401 ? 'signed-out' : error.problem.status === 403 ? 'denied' : 'unavailable' }
      : { kind: 'unavailable' };
  }
}
export const readContextDirectory = createServerFn({ method: 'GET', strict: false })
  .validator((input: Record<string, unknown>) => directoryInput(input))
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return typeof authorization === 'string'
      ? createContextApi(kernelClient(), authorization).list(data)
      : { page: authorization, creation: authorization };
  });
export const readContextCreation = createServerFn({ method: 'GET', strict: false }).handler(async () => {
  const authorization = await viewer();
  return typeof authorization === 'string' ? createContextApi(kernelClient(), authorization).creation() : authorization;
});
export const readContextWorkspace = createServerFn({ method: 'GET', strict: false })
  .validator(parseAddress)
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return typeof authorization === 'string'
      ? createContextApi(kernelClient(), authorization).detail(data.id, data.session)
      : authorization;
  });
export const changeContextWorkspace = createServerFn({ method: 'POST', strict: false })
  .validator(parseCommand)
  .handler(async ({ data }) => {
    const authorization = await viewer();
    return typeof authorization === 'string'
      ? createContextApi(kernelClient(), authorization).submit(data)
      : authorization;
  });
