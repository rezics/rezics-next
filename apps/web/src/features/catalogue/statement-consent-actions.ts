import { candidateAuthorization, expectedCandidateReader } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareSession, sessionSubject } from '../../session/request';
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
  .validator(originalReaderInput(readInput))
  .handler(async ({ data }): Promise<ConsentRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    return authorization
      ? readStatementConsent(kernelClient(), authorization, data, data.cursor, data.session)
      : { ok: false, reason: 'denied' };
  });
export const changeConsent = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(consentCommand))
  .handler(async ({ data }): Promise<ConsentResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    return authorization
      ? changeStatementConsent(kernelClient(), authorization, data)
      : { ok: false, reason: 'denied' };
  });
export const refreshConsentPublic = createServerFn({ method: 'POST', strict: false })
  .validator((input: Parameters<typeof readInput>[0] & { expectedReader?: string | null }) => ({
    ...readInput(input),
    expectedReader:
      input && typeof input === 'object' && input.expectedReader != null ? expectedCandidateReader(input) : null,
  }))
  .handler(async ({ data }): Promise<ConsentPublic> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    if (data.expectedReader !== null) {
      if (sessionSubject(request) !== data.expectedReader) return { state: 'denied' };
    } else if (data.session) return { state: 'denied' };
    return readConsentPublic(kernelClient(), data, data.session, data.terminal);
  });
