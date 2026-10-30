import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import {
  consentAddress,
  consentCommand,
  readStatementConsent,
  changeStatementConsent,
  readConsentPublic,
  type ConsentRead,
  type ConsentResult,
  type ConsentPublic,
} from './statement-consent';

async function credential() {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  await prepareSession(request, env as Partial<SessionEnv>);
  return viewerCredential(request);
}
function readInput(value: unknown) {
  const address = consentAddress(value);
  const input = value as Record<string, unknown>;
  if (
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 8192)) ||
    (input.session !== undefined && (typeof input.session !== 'string' || input.session.length > 16384)) ||
    (input.terminal !== undefined && typeof input.terminal !== 'boolean')
  )
    throw new Error('Invalid consent read');
  return {
    ...address,
    cursor: input.cursor as string | undefined,
    session: input.session as string | undefined,
    terminal: input.terminal === true,
  };
}
// POST server functions retain the application's origin/session/CSRF middleware. No credential enters the browser.
export const readConsent = createServerFn({ method: 'POST', strict: false })
  .validator(readInput)
  .handler(async ({ data }): Promise<ConsentRead> => {
    const authorization = await credential();
    return authorization
      ? readStatementConsent(kernelClient(), authorization, data, data.cursor, data.session)
      : { ok: false, reason: 'denied' };
  });
export const changeConsent = createServerFn({ method: 'POST', strict: false })
  .validator(consentCommand)
  .handler(async ({ data }): Promise<ConsentResult> => {
    const authorization = await credential();
    return authorization
      ? changeStatementConsent(kernelClient(), authorization, data)
      : { ok: false, reason: 'denied' };
  });
export const refreshConsentPublic = createServerFn({ method: 'POST', strict: false })
  .validator(readInput)
  .handler(async ({ data }): Promise<ConsentPublic> => {
    if (!(await credential())) return { state: 'denied' };
    return readConsentPublic(kernelClient(), data, data.session, data.terminal);
  });
