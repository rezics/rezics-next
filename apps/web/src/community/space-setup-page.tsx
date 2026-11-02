import { Link } from '@tanstack/react-router';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import {
  changeSpaceSetup,
  readSpaceSetup,
  resolveSpaceSetupChoice,
  searchSpaceSetupContexts,
  readSpaceSetupBoardChoices,
} from './space-actions';
import { nativeContextChoiceSource } from './setup-context-native';
import { setupBoardChoiceSource } from './setup-board-picker';
import { SpaceSetupForm, type SetupTransport } from './space-setup-form';
import { setupReaderMatches, type SetupSnapshot, type SetupFailure } from './space-setup';
import {
  SpaceSetupCallerLifetime,
  SpaceSetupCallerLifetimeContext,
  type SpaceSetupInitialAdmission,
  claimSpaceSetupInitialSnapshot,
  spaceSetupInitialAdmissionMatchesReader,
  spaceSetupInitialSnapshotMatches,
  spaceSetupSessionSource,
  spaceSetupInitialSnapshotAvailable,
} from './space-setup-lifetime';

const noSubscribe = () => () => {};
const noRevision = () => 0;
const noHydrationSubscribe = () => () => {};
const unavailable: SetupFailure = { kind: 'failure', reason: 'unavailable', status: 503 };
const denied: SetupFailure = { kind: 'failure', reason: 'denied', status: 401 };

function useHydrated() {
  return useSyncExternalStore(
    noHydrationSubscribe,
    () => true,
    () => false,
  );
}

function sessionMatches(
  cached: ReturnType<ReturnType<typeof spaceSetupSessionSource>['read']>,
  expected: { state: string; subject?: string | null | undefined; csrfToken: string | null },
) {
  return (
    !!cached &&
    cached.state === expected.state &&
    (cached.subject ?? null) === (expected.subject ?? null) &&
    (cached.csrfToken ?? null) === expected.csrfToken
  );
}

export function SpaceSetupPage({
  initial,
  admission,
  spaceId,
}: {
  initial: SetupSnapshot | SetupFailure;
  admission?: SpaceSetupInitialAdmission;
  spaceId?: string | undefined;
}) {
  const { csrfToken, state, subject } = useSession();
  const hydrated = useHydrated();
  const locale = getLocale();
  const queryClient = useContext(QueryClientContext) ?? null;
  const sessionSource = queryClient ? spaceSetupSessionSource(queryClient) : null;
  const sessionRevision = useSyncExternalStore(
    sessionSource?.subscribe ?? noSubscribe,
    sessionSource?.snapshot ?? noRevision,
    sessionSource?.snapshot ?? noRevision,
  );
  const cached = sessionSource?.read();
  const initialLoaderMatches = spaceSetupInitialAdmissionMatchesReader(initial, admission);
  const initialSessionMatches = spaceSetupInitialSnapshotMatches(initial, sessionSource, cached, admission);
  const sessionDataUpdateCount = sessionSource?.dataUpdateCount() ?? 0;
  const sessionDataUpdatedAt = sessionSource?.dataUpdatedAt() ?? 0;
  const sessionObservation = sessionSource?.observation();
  const cacheMatches = sessionMatches(cached, { state, subject, csrfToken });
  const readReady =
    hydrated &&
    !!queryClient &&
    cacheMatches &&
    sessionObservation?.status === 'success' &&
    state === 'signed-in' &&
    typeof subject === 'string' &&
    subject.length > 0;
  const commandReady = readReady && typeof csrfToken === 'string' && csrfToken.length > 0;
  const targetSpaceId = spaceId ?? (initial.kind === 'ready' ? (initial.space?.id ?? null) : null);
  const targetRealmId = initial.kind === 'ready' ? (initial.realm?.id ?? null) : null;
  const targetMismatch = !!spaceId && initial.kind === 'ready' && initial.space?.id !== spaceId;
  const initialIdentity = JSON.stringify(initial);
  const boundary = useMemo(
    () => ({}),
    [
      queryClient,
      sessionSource,
      sessionRevision,
      sessionDataUpdateCount,
      sessionDataUpdatedAt,
      state,
      subject,
      csrfToken,
      readReady,
      commandReady,
      locale,
      targetSpaceId,
      initialIdentity,
    ],
  );
  const activeBoundary = useRef(boundary);
  activeBoundary.current = boundary;
  const capturedSession = { state, subject, csrfToken };
  const caller = useMemo(() => {
    const valid = () => {
      if (activeBoundary.current !== boundary || targetMismatch) return false;
      if (!queryClient) return sessionSource === null;
      if (!sessionSource || spaceSetupSessionSource(queryClient) !== sessionSource) return false;
      const current = sessionSource.read();
      const observation = sessionSource.observation();
      return (
        observation.status === 'success' &&
        sessionSource.snapshot() === sessionRevision &&
        sessionSource.dataUpdateCount() === sessionDataUpdateCount &&
        sessionSource.dataUpdatedAt() === sessionDataUpdatedAt &&
        observation.errorUpdateCount === sessionObservation?.errorUpdateCount &&
        observation.errorUpdatedAt === sessionObservation?.errorUpdatedAt &&
        sessionMatches(current, capturedSession)
      );
    };
    return new SpaceSetupCallerLifetime(
      {
        targetSpaceId,
        subject: subject ?? null,
        csrfToken,
        readReady,
        commandReady,
        ready: commandReady,
        locale,
        sessionSource,
        sessionRevision,
        sessionDataUpdateCount,
        sessionDataUpdatedAt,
        sessionErrorUpdateCount: sessionObservation?.errorUpdateCount ?? 0,
        sessionErrorUpdatedAt: sessionObservation?.errorUpdatedAt ?? 0,
      },
      valid,
      sessionSource?.subscribe,
    );
  }, [
    boundary,
    queryClient,
    sessionSource,
    sessionRevision,
    sessionDataUpdateCount,
    sessionDataUpdatedAt,
    state,
    subject,
    csrfToken,
    readReady,
    commandReady,
    locale,
    targetSpaceId,
    targetMismatch,
  ]);

  const boardChoices = useMemo(
    () =>
      setupBoardChoiceSource(async (input) => {
        const ticket = caller.ticket();
        if (!caller.current()) return { kind: 'failure', reason: 'unavailable', status: 503 };
        if (!caller.binding.readReady)
          return { kind: 'failure', reason: caller.binding.subject ? 'denied' : 'unavailable', status: 503 };
        const result = await readSpaceSetupBoardChoices({ data: { ...input, locale } });
        return caller.owns(ticket) && setupReaderMatches(result.reader, caller.binding.subject)
          ? result
          : { kind: 'failure', reason: 'unavailable', status: 503 };
      }),
    [caller, locale],
  );

  const transport = useMemo<SetupTransport>(() => {
    let createdSpaceId: string | null = null;
    let createdRealmId: string | null = null;
    const readable = () => caller.binding.readReady && caller.current();
    const writable = () => caller.binding.commandReady && caller.current();
    const currentFailure = (): SetupFailure => (caller.current() ? denied : unavailable);
    return {
      contexts: nativeContextChoiceSource(
        async (input) => {
          const ticket = caller.ticket();
          if (!readable()) return { kind: caller.current() && caller.binding.subject ? 'denied' : 'unavailable' };
          const result = await searchSpaceSetupContexts({
            data: { query: input.query, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) },
            ...(input.signal ? { signal: input.signal } : {}),
          });
          return caller.owns(ticket) && setupReaderMatches(result.reader, caller.binding.subject)
            ? result
            : { kind: 'unavailable' };
        },
        async (id) => {
          const ticket = caller.ticket();
          if (!readable()) return currentFailure();
          const result = await resolveSpaceSetupChoice({ data: { kind: 'context', id } });
          return caller.owns(ticket) && setupReaderMatches(result.reader, caller.binding.subject)
            ? result
            : unavailable;
        },
        locale,
      ),
      command: async (data) => {
        const ticket = caller.ticket();
        if (!writable()) return currentFailure();
        const expectedSpaceId = targetSpaceId ?? createdSpaceId;
        const expectedRealmId = targetRealmId ?? createdRealmId;
        if (
          ((data.step === 'address' || data.step === 'realm') &&
            (!expectedSpaceId || data.spaceId !== expectedSpaceId)) ||
          ((data.step === 'settings' || data.step === 'scheme' || data.step === 'board') &&
            (!expectedRealmId || data.realmId !== expectedRealmId)) ||
          (data.step === 'space' && targetSpaceId !== null)
        )
          return denied;
        const result = csrfToken ? await changeSpaceSetup({ data, headers: { 'X-CSRF-Token': csrfToken } }) : denied;
        if (!caller.owns(ticket)) return unavailable;
        if (result.kind === 'failure') return result;
        if (data.step === 'space') {
          if (result.kind !== 'space') return unavailable;
          createdSpaceId = result.space.id;
        } else if (data.step === 'address') {
          if (result.kind !== 'space' || result.space.id !== expectedSpaceId) return unavailable;
        } else if (data.step === 'realm') {
          if (result.kind !== 'realm') return unavailable;
          createdRealmId = result.realm.id;
        } else {
          if (result.kind !== 'realm' && data.step !== 'board') return unavailable;
          if (result.kind === 'realm' && result.realm.id !== expectedRealmId) return unavailable;
          if (data.step === 'board' && result.kind !== 'board') return unavailable;
        }
        return result;
      },
      read: async (id) => {
        const ticket = caller.ticket();
        if (!readable()) return currentFailure();
        const requested = id ?? targetSpaceId ?? createdSpaceId ?? undefined;
        if (targetSpaceId && requested !== targetSpaceId) return denied;
        if (!targetSpaceId && createdSpaceId && requested !== createdSpaceId) return denied;
        if (!targetSpaceId && !createdSpaceId && id) return denied;
        const result = await readSpaceSetup({ data: requested ? { spaceId: requested } : {} });
        if (!caller.owns(ticket) || !setupReaderMatches(result.reader, caller.binding.subject)) return unavailable;
        const expected = targetSpaceId ?? createdSpaceId;
        if (expected && result.kind === 'ready' && result.space?.id !== expected) return unavailable;
        return result;
      },
      choice: async (kind, id) => {
        const ticket = caller.ticket();
        if (!readable()) return currentFailure();
        const result = await resolveSpaceSetupChoice({ data: { kind, id } });
        if (!caller.owns(ticket) || !setupReaderMatches(result.reader, caller.binding.subject)) return unavailable;
        if (!('kind' in result) && result.id !== id) return unavailable;
        return result;
      },
    };
  }, [caller, csrfToken, locale, targetRealmId, targetSpaceId]);

  useEffect(() => {
    if (hydrated) claimSpaceSetupInitialSnapshot(initial);
  }, [initial, hydrated]);
  let formInitial: SetupSnapshot | SetupFailure;
  if (!hydrated) formInitial = initialLoaderMatches && initialSessionMatches && !targetMismatch ? initial : unavailable;
  else if (
    readReady &&
    initialLoaderMatches &&
    initialSessionMatches &&
    !targetMismatch &&
    spaceSetupInitialSnapshotAvailable(initial)
  )
    formInitial = initial;
  else formInitial = targetMismatch ? denied : unavailable;

  return (
    <article className="mx-auto max-w-5xl space-y-6 text-foreground">
      <PageHeading>{m.space_setup_heading()}</PageHeading>
      <SpaceSetupCallerLifetimeContext.Provider value={caller}>
        <SpaceSetupForm key={caller.id} initial={formInitial} transport={transport} boardChoices={boardChoices} />
      </SpaceSetupCallerLifetimeContext.Provider>
    </article>
  );
}

/** Share the current native setup result without adding a second admission read. */
export function useSpaceSetupRead(spaceId: string) {
  const session = useSession();
  const hydrated = useHydrated();
  const queryClient = useContext(QueryClientContext) ?? null;
  const sessionSource = queryClient ? spaceSetupSessionSource(queryClient) : null;
  const sessionRevision = useSyncExternalStore(
    sessionSource?.subscribe ?? noSubscribe,
    sessionSource?.snapshot ?? noRevision,
    sessionSource?.snapshot ?? noRevision,
  );
  const cached = sessionSource?.read();
  const dataUpdateCount = sessionSource?.dataUpdateCount() ?? 0;
  const dataUpdatedAt = sessionSource?.dataUpdatedAt() ?? 0;
  const observation = sessionSource?.observation();
  const matches = sessionMatches(cached, session);
  const readReady =
    hydrated &&
    !!queryClient &&
    matches &&
    observation?.status === 'success' &&
    session.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0;
  const boundary = useMemo(
    () => ({}),
    [
      queryClient,
      sessionSource,
      sessionRevision,
      dataUpdateCount,
      dataUpdatedAt,
      session.state,
      session.subject,
      session.csrfToken,
      observation?.errorUpdateCount,
      observation?.errorUpdatedAt,
      spaceId,
    ],
  );
  const activeBoundary = useRef(boundary);
  activeBoundary.current = boundary;
  const current = () => {
    if (!readReady || activeBoundary.current !== boundary || !queryClient || !sessionSource) return false;
    const latest = sessionSource.read();
    const latestObservation = sessionSource.observation();
    return (
      latestObservation.status === 'success' &&
      spaceSetupSessionSource(queryClient) === sessionSource &&
      sessionSource.snapshot() === sessionRevision &&
      sessionSource.dataUpdateCount() === dataUpdateCount &&
      sessionSource.dataUpdatedAt() === dataUpdatedAt &&
      latestObservation.errorUpdateCount === observation?.errorUpdateCount &&
      latestObservation.errorUpdatedAt === observation?.errorUpdatedAt &&
      sessionMatches(latest, session)
    );
  };
  const queryKey = useMemo(
    () =>
      [
        'space-setup-entry',
        spaceId,
        sessionSource?.id ?? null,
        sessionRevision,
        dataUpdateCount,
        dataUpdatedAt,
        observation?.errorUpdateCount ?? 0,
        observation?.errorUpdatedAt ?? 0,
        session.subject ?? null,
      ] as const,
    [
      spaceId,
      sessionSource?.id,
      sessionRevision,
      dataUpdateCount,
      dataUpdatedAt,
      observation?.errorUpdateCount,
      observation?.errorUpdatedAt,
      session.subject,
    ],
  );
  useEffect(() => () => queryClient?.removeQueries({ queryKey, exact: true }), [queryClient, queryKey]);
  const { data, isError } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!current()) throw new Error('Space setup entry caller retired');
      const result = await readSpaceSetup({ data: { spaceId } });
      if (!current() || !setupReaderMatches(result.reader, session.subject ?? null))
        throw new Error('Space setup entry caller retired');
      return result;
    },
    enabled: personalRead.enabled && readReady,
    staleTime: 0,
    retry: false,
  });
  return current() && !isError ? data : undefined;
}

function SpaceSetupEntryLink({ spaceId, read }: { spaceId: string; read: SetupSnapshot | SetupFailure | undefined }) {
  if (read?.kind !== 'ready' || !Object.values(read.permitted).some(Boolean)) return null;
  return (
    <Link
      to="/realms/new"
      search={{ spaceId }}
      className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
    >
      {m.space_setup_entry()}
    </Link>
  );
}

function NativeSpaceSetupEntry({ spaceId }: { spaceId: string }) {
  const read = useSpaceSetupRead(spaceId);
  return <SpaceSetupEntryLink spaceId={spaceId} read={read} />;
}

/** Home shares its read; standalone entries retain their original guarded native reader. */
export function SpaceSetupEntry(props: { spaceId: string; read?: SetupSnapshot | SetupFailure | undefined }) {
  return 'read' in props ? (
    <SpaceSetupEntryLink spaceId={props.spaceId} read={props.read} />
  ) : (
    <NativeSpaceSetupEntry spaceId={props.spaceId} />
  );
}
