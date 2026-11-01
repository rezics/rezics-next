import { QueryClient, queryOptions } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import type { SessionEnv } from '../session/client';
import { sessionQuery } from '../session/query';

export type ViewerExposure = { subject: string | null; admitted: readonly string[] };
export type ViewerObservation = { subject: string; id: number };
export type ViewerExposureSnapshot =
  | { state: 'unknown' | 'inactive' | 'signed-out' }
  | { state: 'signed-in'; observation: ViewerObservation };

const closedExposure: ViewerExposure = { subject: null, admitted: [] };
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
      if (!subject || subject !== expected || !authorization) return closedExposure;
      const { readAdmitted } = await import('./exposure');
      return { subject, admitted: await readAdmitted(authorization) };
    } catch {
      return closedExposure;
    }
  });

export function viewerExposureQuery(observation: ViewerObservation | undefined) {
  return queryOptions({
    queryKey: observation
      ? (['exposure', 'viewer', observation.subject, observation.id] as const)
      : (['exposure', 'viewer', 'closed'] as const),
    queryFn: () =>
      observation ? readViewerExposure({ data: observation.subject }) : Promise.resolve(closedExposure),
    enabled: observation !== undefined,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

function isSessionKey(key: readonly unknown[]): boolean {
  return key.length === sessionQuery.queryKey.length && key[0] === sessionQuery.queryKey[0];
}

type SessionData = { state?: unknown; subject?: unknown; csrfToken?: unknown };

/**
 * Tracks successful session-query incarnations for the mounted operation observers on one client.
 * Every retirement receives a new id, so a late old read can only settle into its discarded key.
 */
class ViewerExposureLifetime {
  private snapshot: ViewerExposureSnapshot = closedSnapshot;
  private listeners = new Set<() => void>();
  private stopQueryCache: (() => void) | undefined;
  private nextId = 0;
  private lastData?: unknown;
  private lastCsrfToken: unknown;
  private lastUpdatedAt = 0;

  constructor(private readonly client: QueryClient) {}

  getSnapshot = (): ViewerExposureSnapshot => this.snapshot;

  getServerSnapshot = (): ViewerExposureSnapshot => closedSnapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) {
      this.stopQueryCache = this.client.getQueryCache().subscribe((event) => {
        if (isSessionKey(event.query.queryKey)) this.reconcile();
      });
      // A remount is a new incarnation even when the session cache still contains the same reader.
      this.reconcile(true);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.retireMountedIncarnation();
    };
  };

  private reconcile(forceFresh = false): void {
    const state = this.client.getQueryState(sessionQuery.queryKey);
    const data = state?.data as SessionData | undefined;
    if (state?.status !== 'success' || !data) {
      this.lastData = undefined;
      this.lastCsrfToken = undefined;
      this.lastUpdatedAt = 0;
      this.transition({ state: 'unknown' });
      return;
    }

    if (data.state === 'signed-out') {
      this.lastData = data;
      this.lastCsrfToken = data.csrfToken;
      this.lastUpdatedAt = state.dataUpdatedAt;
      this.transition({ state: 'signed-out' });
      return;
    }

    if (data.state !== 'signed-in' || typeof data.subject !== 'string' || !data.subject) {
      this.lastData = undefined;
      this.lastCsrfToken = undefined;
      this.lastUpdatedAt = 0;
      this.transition({ state: 'unknown' });
      return;
    }

    const current = this.snapshot;
    const currentObservation = current.state === 'signed-in' ? current.observation : undefined;
    if (
      !forceFresh &&
      currentObservation?.subject === data.subject &&
      this.lastData === data &&
      this.lastCsrfToken === data.csrfToken &&
      this.lastUpdatedAt === state.dataUpdatedAt
    )
      return;

    this.lastData = data;
    this.lastCsrfToken = data.csrfToken;
    this.lastUpdatedAt = state.dataUpdatedAt;
    this.transition({ state: 'signed-in', observation: { subject: data.subject, id: ++this.nextId } });
  }

  private transition(next: ViewerExposureSnapshot): void {
    const previous = this.snapshot;
    const previousObservation = previous.state === 'signed-in' ? previous.observation : undefined;
    const same =
      previous.state === next.state &&
      (previous.state !== 'signed-in' ||
        (next.state === 'signed-in' &&
          previous.observation.id === next.observation.id &&
          previous.observation.subject === next.observation.subject));
    if (same) return;

    this.snapshot = next;
    if (previousObservation) {
      this.client.removeQueries({
        queryKey: ['exposure', 'viewer', previousObservation.subject, previousObservation.id],
        exact: true,
      });
    }
    this.listeners.forEach((notify) => notify());
  }

  private retireMountedIncarnation(): void {
    this.stopQueryCache?.();
    this.stopQueryCache = undefined;
    this.lastData = undefined;
    this.lastCsrfToken = undefined;
    this.lastUpdatedAt = 0;
    const previous = this.snapshot;
    const previousObservation = previous.state === 'signed-in' ? previous.observation : undefined;
    this.snapshot = { state: 'inactive' };
    if (previousObservation) {
      this.client.removeQueries({
        queryKey: ['exposure', 'viewer', previousObservation.subject, previousObservation.id],
        exact: true,
      });
    }
  }
}

const lifetimes = new WeakMap<QueryClient, ViewerExposureLifetime>();

export function viewerExposureLifetime(client: QueryClient): ViewerExposureLifetime {
  let lifetime = lifetimes.get(client);
  if (!lifetime) {
    lifetime = new ViewerExposureLifetime(client);
    lifetimes.set(client, lifetime);
  }
  return lifetime;
}
