import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { notFound } from '@tanstack/react-router';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { ReporterStatusRead, ReporterStatusViewer } from './reporter-status-read-model';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
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

/** Additive private result wrapper; the public loader above retains its 404/null and failure contract. */
export async function loadPrivateReporterStatus(
  client: Pick<KernelClient, 'reports'>,
  id: string,
  generation: string,
  authorization: string,
  viewer: ReporterStatusViewer,
): Promise<ReporterStatusRead> {
  const base = { id, generation, viewer };
  try {
    const result = await client.reports({ id }).get({ headers: { authorization } });
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { ...base, result: { state: 'closed' } };
    if (result.error) {
      if (result.status === 401 || result.status === 403 || result.status === 404)
        return { ...base, result: { state: 'concealed' } };
      return { ...base, result: { state: 'unavailable' } };
    }
    const report = reporterStatusResponse(result.data);
    return { ...base, result: report.id === id ? { state: 'loaded', report } : { state: 'concealed' } };
  } catch (error) {
    return { ...base, result: { state: isPlatformClosedError(error) ? 'closed' : 'unavailable' } };
  }
}

export const readReporterStatus = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      typeof input.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id) ||
      !('generation' in input) ||
      typeof input.generation !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(input.generation)
    )
      throw notFound();
    return { id: input.id, generation: input.generation };
  })
  .handler(async ({ data }): Promise<ReporterStatusRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadReporterStatusRequest(getRequest(), env as Partial<SessionEnv>, data);
  });

/** Prepared BFF request boundary, also used by the default-composition regression's local transport. */
export async function loadReporterStatusRequest(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  data: { id: string; generation: string },
  client: () => Pick<KernelClient, 'reports'> = kernelClient,
): Promise<ReporterStatusRead> {
  const base = { ...data, viewer: null };
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const subject = sessionSubject(request);
    const csrfToken = requestCsrfToken(request);
    if (!authorization || !subject || !csrfToken) return { ...base, result: { state: 'concealed' } };
    return await loadPrivateReporterStatus(client(), data.id, data.generation, authorization, { subject, csrfToken });
  } catch {
    return { ...base, result: { state: 'unavailable' } };
  }
}
