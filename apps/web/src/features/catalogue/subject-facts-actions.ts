import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../../kernel/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { factCommandInput, proposeFact, type FactResult } from './subject-facts';

/** One ordinary proposal per action, through the existing identity, CSRF and session boundary. */
export const submitFactCorrection = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(factCommandInput))
  .handler(async ({ data }): Promise<FactResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    if ('invalid' in data) return { ok: false, reason: 'invalid' };
    return proposeFact(kernelClient(), authorization, data);
  });
