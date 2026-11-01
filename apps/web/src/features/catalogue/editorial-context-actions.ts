import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { MediaProblem } from '../../media/kernel';
import { kernelClient } from '../../kernel/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import {
  editorialAddress,
  editorialCommand,
  readEditorialContext,
  submitEditorialContext,
  type EditorialFailure,
  type EditorialRead,
  type EditorialResult,
} from './editorial-context';

async function credential(expectedReader: string): Promise<string | EditorialFailure> {
  setResponseHeader('cache-control', 'private, no-store');
  try {
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    return (await candidateAuthorization(expectedReader)) ?? { ok: false, reason: 'denied' };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof MediaProblem && (error.problem.status === 401 || error.problem.status === 403)
          ? 'denied'
          : 'unavailable',
    };
  }
}
export const readEditorialWorkspace = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(editorialAddress))
  .handler(async ({ data }): Promise<EditorialRead> => {
    const authorization = await credential(data.expectedReader);
    return typeof authorization === 'string'
      ? readEditorialContext(kernelClient(), authorization, data)
      : authorization;
  });
export const changeEditorialWorkspace = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(editorialCommand))
  .handler(async ({ data }): Promise<EditorialResult> => {
    const authorization = await credential(data.expectedReader);
    return typeof authorization === 'string'
      ? submitEditorialContext(kernelClient(), authorization, data)
      : authorization;
  });
