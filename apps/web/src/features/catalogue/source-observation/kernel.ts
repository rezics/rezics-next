import type { KernelClient } from '@rezics/client';
import type { SourceObservationOperation, SourceObservationRequest } from './contract';

type ObservationQuery = {
  digest?: string;
  cursor?: string;
  history?: 'true';
};

function observationQuery(request: SourceObservationRequest): ObservationQuery {
  return {
    ...(request.digest !== undefined ? { digest: request.digest } : {}),
    ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
    ...(request.history === true ? { history: 'true' as const } : {}),
  };
}

/**
 * Installed Subject source-statistics observations GET. CAS resolution is dropped by admitSourceObservation.
 */
export function sourceObservationOperation(client: KernelClient): SourceObservationOperation {
  return async (request) => {
    const result = await client
      .subjects({ id: request.subjectId })
      ['source-statistics']({ source: request.source })
      .observations.get({
        query: observationQuery(request),
        fetch: { cache: 'no-store', redirect: 'manual' },
      });
    return { status: result.status, data: result.data ?? result.error?.value };
  };
}
