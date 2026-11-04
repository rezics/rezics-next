import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { hasKernelOrigin, kernelClient } from '../../kernel/client';
import { prepareSession, viewerCredential } from '../../session/request';
import type { SessionEnv } from '../../session/client';
import { preparedPrivateReaderOrigin } from '../private-reader-origin';
import type { ReporterHistoryRead } from './journey';
import { reporterHistoryQuery } from './model';
import { loadReporterHistory } from './read';

export type { ReporterHistoryRead } from './journey';
/** Preparation is session scoped; the browser supplies only cursor and exact report operands. */
export const readReporterHistory = createServerFn({ method: 'GET' })
  .validator(reporterHistoryQuery)
  .handler(async ({ data }): Promise<ReporterHistoryRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    try {
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      const readerOrigin = await preparedPrivateReaderOrigin(request, authorization);
      if (!authorization || !readerOrigin) return { readerOrigin: null, result: { state: 'denied' } };
      if (!hasKernelOrigin()) return { readerOrigin, result: { state: 'unavailable' } };
      return {
        readerOrigin,
        result: await loadReporterHistory(kernelClient(undefined, authorization), data, request.signal),
      };
    } catch {
      return { readerOrigin: null, result: { state: 'unavailable' } };
    }
  });
