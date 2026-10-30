import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { reporterStatusResponse, type ReporterStatus } from './reporter-status-model';

/** One exact private read. A failed dependency remains retryable; only 404 is absent. */
export async function loadReporterStatus(
  client: Pick<KernelClient, 'reports'>,
  id: string,
  authorization: string,
): Promise<ReporterStatus | null> {
  const result = await client.reports({ id }).get({ headers: { authorization } });
  if (result.error) {
    if (result.status === 404) return null;
    throw new Error('Report status unavailable');
  }
  return reporterStatusResponse(result.data);
}

export const readReporterStatus = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)
    )
      throw notFound();
    return { id: input.id };
  })
  .handler(async ({ data }): Promise<ReporterStatus> => {
    setResponseHeader('cache-control', 'private, no-store');
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>);
    const authorization = viewerCredential(request);
    if (!authorization) throw notFound();
    const report = await loadReporterStatus(kernelClient(), data.id, authorization);
    if (!report) throw notFound();
    return report;
  });
