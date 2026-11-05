import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { kernelClient } from '../../../kernel/client';
import { candidateAuthorization } from '../../../subject/candidate-admission';
import { connectionAddress } from '../../pages/subject-connections-query';
import { readConnectionVisit, type ConnectionVisit } from '../../pages/subject-connections';

/** The installed Connections reader owns native admission, freshness and selected-page identity. */
export const loadCharacterPublicReading = createServerFn({ method: 'GET', strict: false })
  .validator(connectionAddress)
  .handler(async ({ data }): Promise<ConnectionVisit> => {
    setResponseHeader('cache-control', 'private, no-store');
    const authorization = data.viewer ? await candidateAuthorization(data.viewer) : undefined;
    if (data.viewer && !authorization) return { ok: false, status: 401 };
    return readConnectionVisit(kernelClient(data.locale), data, authorization ?? undefined, getRequest().signal, {
      groups: ['characters', 'credits'],
    });
  });
