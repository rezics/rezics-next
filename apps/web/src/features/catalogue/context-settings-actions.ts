import { candidateAuthorization } from '../../subject/candidate-admission';
import { originalReaderInput } from './editor-reader-input';
import { createServerFn } from '@tanstack/react-start';
import { setResponseHeader } from '@tanstack/react-start/server';
import { MediaProblem } from '../../media/kernel';
import { kernelClient } from '../../kernel/client';
import type { EditorialFailure } from './editorial-context';
import { editorialSettingsInput, readEditorialSettings } from './context-settings';
import type { SettingsRead } from '../contexts/settings';

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

export const readEditorialSettingsChoices = createServerFn({ method: 'POST', strict: false })
  .validator(originalReaderInput(editorialSettingsInput))
  .handler(async ({ data }): Promise<SettingsRead> => {
    const authorization = await credential(data.expectedReader);
    return typeof authorization === 'string'
      ? readEditorialSettings(kernelClient(), authorization, data.digest, data.session)
      : { kind: authorization.reason === 'denied' ? 'denied' : 'unavailable' };
  });
