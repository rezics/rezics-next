import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { operationIsAdmitted, type GatedOperation } from '../kernel/exposure';
import type { useSession } from '../session/query';

type Session = ReturnType<typeof useSession>;
type Operation = Extract<GatedOperation, `progress_session.${string}`>;

// Observe the same existing queries as useSession/useOperation. This adds no read.
const sessionKey = ['session'] as const;
const exposureKey = ['exposure', 'viewer'] as const;
const observedSession = new WeakSet<QueryClient>();
const observedExposure = new WeakSet<QueryClient>();
const unknownSession: Session = { state: 'unknown', csrfToken: null, subject: null };

export function progressIndexSession(client: QueryClient, rendered: Session): Session {
  const state = client.getQueryState<Session>(sessionKey);
  if (!state) return observedSession.has(client) ? unknownSession : rendered;
  observedSession.add(client);
  return state.status === 'success' && state.data ? state.data : unknownSession;
}

export function progressIndexAdmission(client: QueryClient, operation: Operation, rendered: boolean): boolean {
  const state = client.getQueryState<string[]>(exposureKey);
  if (!state) return !observedExposure.has(client) && rendered;
  observedExposure.add(client);
  return state.status === 'success' && operationIsAdmitted(operation, state.data);
}

export type ProgressAuthority = {
  key: object;
  isCurrent: () => boolean;
  permits: (operation: Operation, rendered: boolean) => boolean;
  headers: () => { 'x-csrf-token': string } | null;
};

export type ProgressEpisode = {
  identity: unknown;
  generation: number;
  pending: boolean;
  retired: boolean;
  revoked: boolean;
  mounted: boolean;
  validate: () => boolean;
  isCurrent: () => boolean;
};

/** Cache events retire monotonically, including away/back events before React commits. */
export function useProgressEpisode(identity: unknown, validate: () => boolean) {
  const client = useContext(QueryClientContext);
  const latest = useRef<ProgressEpisode | null>(null);
  const [, render] = useState(0);
  if (!latest.current || latest.current.identity !== identity || (latest.current.retired && validate())) {
    const previous = latest.current;
    if (previous) previous.retired = true;
    const episode: ProgressEpisode = {
      identity,
      generation: (previous?.generation ?? 0) + 1,
      pending: false,
      retired: !validate(),
      revoked: !validate(),
      mounted: previous?.mounted ?? false,
      validate,
      isCurrent: () => {
        if (latest.current !== episode || episode.retired || !episode.mounted) return false;
        if (!episode.validate()) {
          episode.retired = episode.revoked = true;
          render((value) => value + 1);
          return false;
        }
        return true;
      },
    };
    latest.current = episode;
  }
  const episode = latest.current;
  episode.validate = validate;
  if (!validate()) episode.retired = episode.revoked = true;
  useLayoutEffect(() => {
    // Strict effects can reattach a mounted operand, but never unretire it.
    latest.current!.mounted = true;
    const observe = () => {
      const current = latest.current!;
      if (!current.retired && !current.validate()) {
        current.retired = current.revoked = true;
        render((value) => value + 1);
      }
    };
    const unsubscribe = client?.getQueryCache().subscribe(observe);
    observe();
    return () => {
      unsubscribe?.();
      latest.current!.mounted = false;
    };
  }, [client]);
  return episode;
}

/** Action admission is independent of list admission and of sibling actions. */
export function useProgressAction(
  authority: ProgressAuthority | undefined,
  operation: Operation,
  admitted: boolean,
  context: unknown,
) {
  const allowed = authority ? authority.permits(operation, admitted) : true;
  const identity = useMemo(() => ({ parent: authority?.key, context, allowed }), [authority?.key, context, allowed]);
  return useProgressEpisode(identity, () => (authority ? authority.permits(operation, admitted) : true));
}
