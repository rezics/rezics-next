import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubjectRead } from '@rezics/client';
import type { SelectedContext } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { browserObservation } from '../../../../session';
import { useCatalogueLifetime } from '../../../../subject/candidate-lifetime';
import { recordingReaderVisit, type RecordingVisit } from '../model';
import type { RecordingReleaseRead } from '../read';

export type RecordingReleaseLoader = (digest: string) => Promise<RecordingReleaseRead>;

type ReleaseAttempt = {
  scope: number;
  operation: number | null;
  result: RecordingReleaseRead;
};

type ExplicitOperation = { scope: number; token: number };

/** One current browser episode owns the public release observation and any deliberate retry. */
export function useRecordingRelease({
  locale,
  public: publicRead,
  bounds,
  context,
  loadRelease,
}: {
  locale: string;
  public: SubjectRead;
  bounds?: Parameters<typeof recordingReaderVisit>[0]['bounds'];
  context?: SelectedContext;
  loadRelease: RecordingReleaseLoader;
}): {
  visit: RecordingVisit;
  release?: Release;
  retryAvailable: boolean;
  retrying: boolean;
  generation: number;
  active: () => boolean;
  retry: (onCurrentSuccess?: () => void) => Promise<boolean>;
} {
  const client = useQueryClient();
  const observation = useMemo(() => browserObservation(client), [client]);
  const subscribe = useCallback((changed: () => void) => observation.subscribeCache(changed), [observation]);
  const browser = useSyncExternalStore(subscribe, observation.getSnapshot, observation.getServerSnapshot);

  const sourceVersion = useRef<{ source: SubjectRead; value: number } | null>(null);
  if (!sourceVersion.current || sourceVersion.current.source !== publicRead) {
    sourceVersion.current = {
      source: publicRead,
      value: (sourceVersion.current?.value ?? 0) + 1,
    };
  }

  const source = publicRead.subject;
  const sourceEpoch = sourceVersion.current.value;
  const contextKey = JSON.stringify(context ?? null);
  const browserIdentity =
    browser.state === 'signed-in'
      ? `signed-in:${browser.observation.subject}:${browser.observation.id}`
      : browser.state;
  const work = useCatalogueLifetime(
    JSON.stringify([
      source.id,
      source.context,
      source.revision,
      source.release,
      sourceEpoch,
      locale,
      contextKey,
      browserIdentity,
    ]),
  );
  const queryKey = useMemo(
    () =>
      [
        'recording-reader-release',
        source.id,
        source.context ?? '',
        source.revision,
        source.release,
        locale,
        contextKey,
        sourceEpoch,
      ] as const,
    [contextKey, locale, source.context, source.id, source.release, source.revision, sourceEpoch],
  );

  const operationRef = useRef<ExplicitOperation | null>(null);
  const nextOperation = useRef(0);
  const [pendingOperation, setPendingOperation] = useState<ExplicitOperation | null>(null);
  const [acceptedOperation, setAcceptedOperation] = useState<ExplicitOperation | null>(null);

  useLayoutEffect(() => {
    if (operationRef.current?.scope !== work.generation) operationRef.current = null;
    setPendingOperation((current) => (current?.scope === work.generation ? current : null));
    setAcceptedOperation((current) => (current?.scope === work.generation ? current : null));
  }, [work.generation]);

  useEffect(() => {
    const key = queryKey;
    const generation = work.generation;
    return () => {
      void client.cancelQueries({ queryKey: key, exact: true });
      if (operationRef.current?.scope === generation) operationRef.current = null;
    };
  }, [client, queryKey, work.generation]);

  const query = useQuery<ReleaseAttempt>({
    queryKey,
    queryFn: async () => {
      const generation = work.generation;
      const activeOperation = operationRef.current;
      const result = await loadRelease(source.release);
      return {
        scope: generation,
        operation: activeOperation?.scope === generation ? activeOperation.token : null,
        result,
      };
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const retrying = pendingOperation?.scope === work.generation;
  const data = query.data?.scope === work.generation ? query.data : undefined;
  const accepted =
    !!data &&
    (data.operation === null ||
      (acceptedOperation?.scope === work.generation && acceptedOperation.token === data.operation) ||
      (retrying && pendingOperation.token === data.operation));
  const currentRead = accepted && data?.result.ok && data.result.digest === source.release ? data.result : undefined;
  const loading =
    query.isLoading ||
    (typeof window === 'undefined' && query.isPending) ||
    retrying ||
    (query.isFetching && !currentRead);
  const failed =
    !loading &&
    !currentRead &&
    (query.isError || !accepted || !data?.result.ok || data?.result.digest !== source.release);
  const visit = recordingReaderVisit({
    locale,
    public: publicRead,
    ...(currentRead ? { release: currentRead.release, releaseDigest: currentRead.digest } : {}),
    ...(failed ? { reason: 'unavailable' as const } : {}),
    ...(bounds ? { bounds } : {}),
    ...(loading ? { loading: true } : {}),
  });

  const retry = useCallback(
    async (onCurrentSuccess?: () => void) => {
      if (!work.active() || retrying || query.isFetching || operationRef.current?.scope === work.generation)
        return false;
      const operation = { scope: work.generation, token: ++nextOperation.current };
      operationRef.current = operation;
      setPendingOperation(operation);
      try {
        const result = await query.refetch();
        const attempt = result.data;
        if (
          !work.active() ||
          operationRef.current !== operation ||
          attempt?.scope !== operation.scope ||
          attempt.operation !== operation.token
        )
          return false;
        const succeeded = attempt.result.ok && attempt.result.digest === source.release;
        if (succeeded) onCurrentSuccess?.();
        setAcceptedOperation(operation);
        return succeeded;
      } catch {
        return false;
      } finally {
        if (operationRef.current === operation) {
          operationRef.current = null;
          if (work.active()) setPendingOperation((current) => (current === operation ? null : current));
        }
      }
    },
    [query, retrying, source.release, work],
  );

  return {
    visit,
    ...(currentRead ? { release: currentRead.release } : {}),
    retryAvailable: failed && visit.state === 'unavailable',
    retrying,
    generation: work.generation,
    active: work.active,
    retry,
  };
}
