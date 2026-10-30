import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { recordPageReadCacheControl } from '../../security/page-cache';
import { commandExposure, loadExposure, parseIntent, type Outcome, type Page } from './data';

async function viewer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  recordPageReadCacheControl(request, 'private, no-store');
  // Shared middleware validates the current session, Origin and session-bound CSRF for unsafe calls.
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}
const configured = () => Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);

export const readPlatformExposure = createServerFn({ method: 'GET' }).handler(async (): Promise<Page> => {
  const authorization = await viewer();
  if (!authorization) return { status: 'signed-out' };
  if (!configured()) return { status: 'unavailable' };
  return loadExposure(kernelClient(), authorization);
});
export const changePlatformExposure = createServerFn({ method: 'POST' })
  .validator(parseIntent)
  .handler(async ({ data }): Promise<Outcome> => {
    const authorization = await viewer();
    if (!authorization) return { status: 'not-sent', current: { status: 'signed-out' } };
    if (!configured()) return { status: 'not-sent', current: { status: 'unavailable' } };
    return commandExposure(kernelClient(), authorization, data);
  });
