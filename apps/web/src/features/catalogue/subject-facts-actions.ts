import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../kernel/client';
import { factCommandInput, proposeFact, type FactResult } from './subject-facts';

/** One ordinary proposal per action, through the existing identity, CSRF and session boundary. */
export const submitFactCorrection = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(factCommandInput))
  .handler(async ({ data }): Promise<FactResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = await candidateAuthorization(data.expectedReader);
    if (!authorization) return { ok: false, reason: 'denied' };
    if ('invalid' in data) return { ok: false, reason: 'invalid' };
    return proposeFact(kernelClient(), authorization, data);
  });
