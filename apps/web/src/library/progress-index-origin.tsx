import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { operationIsAdmitted, type GatedOperation } from '../kernel/exposure';
import { sessionQuery, type useSession } from '../session/query';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import type { ProgressIndex } from './progress-reads';

type Session = ReturnType<typeof useSession>;
type Operation = Extract<GatedOperation, `progress_session.${string}`>;

const progressOperations = [
  'progress_session.list',
  'progress_session.create',
  'progress_session.read',
  'progress_session.complete',
  'progress_session.abandon',
] as const;
const unknownSession: Session = { state: 'unknown', csrfToken: null, subject: null };

export function progressIndexSession(client: QueryClient, _rendered: Session): Session {
  const state = client.getQueryState(sessionQuery.queryKey);
  return state?.status === 'success' && state.data ? state.data : unknownSession;
}

export function progressIndexAdmission(client: QueryClient, operation: Operation, _rendered: boolean): boolean {
  const session = progressIndexSession(client, unknownSession);
  const enrolled = viewerExposureLifetime(client).getSnapshot();
  if (
    session.state !== 'signed-in' ||
    !session.subject ||
    (operation !== 'progress_session.list' && !session.csrfToken) ||
    enrolled.state !== 'signed-in' ||
    enrolled.observation.subject !== session.subject
  )
    return false;
  const state = client.getQueryState(viewerExposureQuery(enrolled.observation).queryKey);
  return (
    state?.status === 'success' &&
    state.data?.subject === enrolled.observation.subject &&
    operationIsAdmitted(operation, state.data.admitted)
  );
}

export type ProgressAuthority = {
  key: object;
  isCurrent: () => boolean;
  permits: (operation: Operation, rendered: boolean) => boolean;
  headers: () => { 'x-csrf-token': string } | null;
  rowCurrent: (context: string) => boolean;
  episode?: (operation: Operation) => number | undefined;
  retained?: (operation: Operation) => boolean;
};

/** Stored native context, independently of current summary labels and covers. */
export function progressRowContext(row: ProgressIndex['sessions'][number]) {
  return JSON.stringify([
    row.id,
    row.subjectId,
    row.versionSubjectId,
    row.revision,
    row.mode,
    row.unit,
    row.total,
    row.amount,
    row.locator,
    row.position,
    row.completedUnitCount,
    row.state,
    row.startedAt,
    row.completedAt,
  ]);
}

export type ProgressEpisode = {
  identity: unknown;
  generation: number;
  pending: boolean;
  retired: boolean;
  revoked: boolean;
  mounted: boolean;
  validate: () => boolean;
  admissionLost: () => boolean;
  available: () => boolean;
  isCurrent: () => boolean;
};

/** Cache events retire monotonically, including away/back events before React commits. */
export function useProgressEpisode(
  identity: unknown,
  validate: () => boolean,
  admissionLost = () => !validate(),
  available = () => true,
) {
  const client = useContext(QueryClientContext);
  useLibraryWorkspaceAdmission(progressOperations);
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
      revoked: admissionLost(),
      mounted: previous?.mounted ?? false,
      validate,
      admissionLost,
      available,
      isCurrent: () => {
        if (latest.current !== episode || episode.retired || !episode.mounted || !episode.available()) return false;
        if (!episode.validate()) {
          episode.retired = true;
          episode.revoked ||= episode.admissionLost();
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
  episode.admissionLost = admissionLost;
  episode.available = available;
  if (!validate()) {
    episode.retired = true;
    episode.revoked ||= admissionLost();
  }
  useLayoutEffect(() => {
    // Strict effects can reattach a mounted operand, but never unretire it.
    if (!episode.retired) episode.mounted = true;
    const observe = () => {
      const current = latest.current!;
      current.revoked ||= current.admissionLost();
      if (!current.retired && !current.validate()) {
        current.retired = true;
        current.revoked ||= current.admissionLost();
        render((value) => value + 1);
      }
    };
    const unsubscribe = client?.getQueryCache().subscribe(observe);
    observe();
    return () => {
      unsubscribe?.();
      episode.mounted = false;
    };
  }, [client, episode]);
  return episode;
}

/** Action admission is independent of list admission and of sibling actions. */
export function useProgressAction(
  authority: ProgressAuthority | undefined,
  operation: Operation,
  admitted: boolean,
  context: unknown,
  contextCurrent: () => boolean = () => true,
) {
  const allowed = authority ? (authority.retained?.(operation) ?? authority.permits(operation, admitted)) : true;
  const version = authority?.episode?.(operation);
  const identity = useMemo(
    () => ({ parent: authority?.key, context, allowed, version }),
    [authority?.key, context, allowed, version],
  );
  const permits = () => (authority ? authority.permits(operation, admitted) : true);
  return useProgressEpisode(
    identity,
    () =>
      (authority?.retained ? authority.retained(operation) : permits()) &&
      authority?.episode?.(operation) === version &&
      contextCurrent(),
    () => !allowed,
    permits,
  );
}
