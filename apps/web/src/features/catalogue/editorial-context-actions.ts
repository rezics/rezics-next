import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { MediaProblem } from '../../media/kernel';
import { kernelClient } from '../../kernel/client';
import {
  editorialAddress,
  editorialCommand,
  editorialCreationInput,
  readEditorialCreationActions,
  readEditorialContext,
  submitEditorialContext,
  type EditorialFailure,
  type EditorialRead,
  type EditorialResult,
} from './editorial-context';
import type { Actions, Result } from '../contexts/model';

async function credential(expectedReader: string): Promise<string | EditorialFailure> {
  setResponseHeader('cache-control', 'private, no-store');
  try {
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
export const readEditorialCreation = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(editorialCreationInput))
  .handler(async ({ data }): Promise<Result<Actions>> => {
    const authorization = await credential(data.expectedReader);
    return typeof authorization === 'string'
      ? readEditorialCreationActions(kernelClient(), authorization, data.session)
      : { kind: authorization.reason === 'denied' ? 'denied' : 'unavailable' };
  });
export const changeEditorialWorkspace = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(editorialCommand))
  .handler(async ({ data }): Promise<EditorialResult> => {
    const { expectedReader, ...command } = data;
    const authorization = await credential(expectedReader);
    return typeof authorization === 'string'
      ? submitEditorialContext(kernelClient(), authorization, command)
      : authorization;
  });
