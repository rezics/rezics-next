import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { commandLifecycle, loadLifecycle, parseIntent, parseSelection, type Outcome, type Page } from './data';

async function viewer() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  // Existing unsafe-request Origin and session-CSRF checks run before any native operation.
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}
function realKernelConfigured() {
  // Never use the development fake as current management/capability or command evidence.
  return Boolean((env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN);
}
export const readAccountLifecycle = createServerFn({ method: 'GET' })
  .validator(parseSelection)
  .handler(async ({ data }): Promise<Page> => {
    const authorization = await viewer();
    if (!authorization) return { status: 'signed-out' };
    if (!realKernelConfigured()) return { status: 'unavailable' };
    return loadLifecycle(kernelClient(), authorization, data.accountId, undefined, getRequest().signal);
  });
export const changeAccountLifecycle = createServerFn({ method: 'POST' })
  .validator(parseIntent)
  .handler(async ({ data }): Promise<Outcome> => {
    const authorization = await viewer();
    if (!authorization) return { status: 'signed-out' };
    if (!realKernelConfigured()) return { status: 'unavailable' };
    return commandLifecycle(kernelClient(), authorization, data, getRequest().signal);
  });
