import { QueryClient, queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../session/client';
import { sessionQuery } from '../session/query';

export type ExposureReadState = 'ready' | 'denied' | 'unavailable';
export type ViewerExposure = { subject: string | null; admitted: readonly string[]; state?: ExposureReadState };
export type ViewerObservation = { subject: string; id: number };
export type ViewerExposureSnapshot =
  | { state: 'unknown' | 'inactive' | 'signed-out' }
  | { state: 'signed-in'; observation: ViewerObservation };

const closedExposure: ViewerExposure = { subject: null, admitted: [], state: 'unavailable' };
const closedSnapshot: ViewerExposureSnapshot = { state: 'unknown' };

function expectedSubject(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) throw new Error('Invalid viewer');
  return value;
}

/** The subject and credential are captured from the same prepared request as the exposure read. */
export const readViewerExposure = createServerFn({ method: 'GET' })
  .validator(expectedSubject)
  .handler(async ({ data: expected }) => {
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const { env } = await import('cloudflare:workers');
      const { prepareSession, sessionSubject, viewerCredential } = await import('../session/request');
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
      const subject = sessionSubject(request);
      const authorization = viewerCredential(request);
      // The expected subject can reject a read, but only the prepared request establishes its identity.
      if (!subject || subject !== expected || !authorization) return { ...closedExposure, state: 'denied' };
      const { readAdmittedResult } = await import('./exposure');
      return { subject, ...(await readAdmittedResult(authorization)) };
    } catch {
      return { ...closedExposure, state: 'unavailable' };
    }
  });

export function viewerExposureQuery(observation: ViewerObservation | undefined) {
  return queryOptions({
    queryKey: observation
      ? (['exposure', 'viewer', observation.subject, observation.id] as const)
      : (['exposure', 'viewer', 'closed'] as const),
    queryFn: () => (observation ? readViewerExposure({ data: observation.subject }) : Promise.resolve(closedExposure)),
    enabled: observation !== undefined,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

// Compatibility for operation callers; session owns observation and retirement.
export { browserObservation as viewerExposureLifetime } from '../session/observation';
