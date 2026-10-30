import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { editorialAddress, editorialCommand, readEditorialContext, submitEditorialContext, type EditorialRead, type EditorialResult } from './editorial-context';

async function credential() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}
export const readEditorialWorkspace = createServerFn({ method: 'POST', strict: false })
  .validator(editorialAddress)
  .handler(async ({ data }): Promise<EditorialRead> => {
    const authorization = await credential();
    return authorization ? readEditorialContext(kernelClient(), authorization, data) : { ok: false, reason: 'denied' };
  });
export const changeEditorialWorkspace = createServerFn({ method: 'POST', strict: false })
  .validator(editorialCommand)
  .handler(async ({ data }): Promise<EditorialResult> => {
    const authorization = await credential();
    return authorization ? submitEditorialContext(kernelClient(), authorization, data) : { ok: false, reason: 'denied' };
  });
