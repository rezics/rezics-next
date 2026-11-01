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
import type { SetupSnapshot, SetupFailure } from './space-setup';
import {
  SpaceSetupCallerLifetime,
  SpaceSetupCallerLifetimeContext,
  claimSpaceSetupInitialSnapshot,
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

function unavailableRead(spaceId?: string): Promise<SetupSnapshot | SetupFailure> {
  return Promise.resolve(spaceId ? denied : unavailable);
}

export function SpaceSetupPage({
  initial,
  spaceId,
}: {
  initial: SetupSnapshot | SetupFailure;
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
  const initialSessionMatches = spaceSetupInitialSnapshotMatches(initial, sessionSource, cached);
  const sessionDataUpdateCount = sessionSource?.dataUpdateCount() ?? 0;
  const sessionDataUpdatedAt = sessionSource?.dataUpdatedAt() ?? 0;
  const cacheMatches = sessionMatches(cached, { state, subject, csrfToken });
  const ready =
    hydrated &&
    !!queryClient &&
    cacheMatches &&
    state === 'signed-in' &&
    typeof subject === 'string' &&
    subject.length > 0 &&
    typeof csrfToken === 'string' &&
    csrfToken.length > 0;
  const targetSpaceId = spaceId ?? (initial.kind === 'ready' ? (initial.space?.id ?? null) : null);
  const targetRealmId = initial.kind === 'ready' ? (initial.realm?.id ?? null) : null;
  const targetMismatch =
    !!spaceId && initial.kind === 'ready' && initial.space?.id !== spaceId;
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
      return (
        sessionSource.snapshot() === sessionRevision &&
        sessionSource.dataUpdateCount() === sessionDataUpdateCount &&
        sessionSource.dataUpdatedAt() === sessionDataUpdatedAt &&
        sessionMatches(current, capturedSession)
      );
    };
    return new SpaceSetupCallerLifetime(
      {
        targetSpaceId,
        subject: subject ?? null,
        csrfToken,
        ready,
        locale,
        sessionSource,
        sessionRevision,
        sessionDataUpdateCount,
        sessionDataUpdatedAt,
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
    ready,
    locale,
    targetSpaceId,
    targetMismatch,
  ]);

  const boardChoices = useMemo(
    () =>
      setupBoardChoiceSource(async (input) => {
        const ticket = caller.ticket();
        if (!caller.binding.ready || !caller.current())
          return { kind: 'failure', reason: caller.current() ? 'denied' : 'unavailable', status: 503 };
        const result = await readSpaceSetupBoardChoices({ data: { ...input, locale } });
        return caller.owns(ticket) ? result : { kind: 'failure', reason: 'unavailable', status: 503 };
      }),
    [caller, locale],
  );

  const transport = useMemo<SetupTransport>(() => {
    let createdSpaceId: string | null = null;
    let createdRealmId: string | null = null;
    const authorized = () => caller.binding.ready && caller.current();
    const currentFailure = (): SetupFailure => (caller.current() ? denied : unavailable);
    return {
      contexts: nativeContextChoiceSource(
        async (input) => {
          const ticket = caller.ticket();
          if (!authorized()) return { kind: caller.current() ? 'denied' : 'unavailable' };
          const result = await searchSpaceSetupContexts({
            data: { query: input.query, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) },
            ...(input.signal ? { signal: input.signal } : {}),
          });
          return caller.owns(ticket) ? result : { kind: 'unavailable' };
        },
        async (id) => {
          const ticket = caller.ticket();
          if (!authorized()) return currentFailure();
          const result = await resolveSpaceSetupChoice({ data: { kind: 'context', id } });
          return caller.owns(ticket) ? result : unavailable;
        },
        locale,
      ),
      command: async (data) => {
        const ticket = caller.ticket();
        if (!authorized()) return currentFailure();
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
        const result = csrfToken
          ? await changeSpaceSetup({ data, headers: { 'X-CSRF-Token': csrfToken } })
          : denied;
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
        if (!authorized()) return currentFailure();
        const requested = id ?? targetSpaceId ?? createdSpaceId ?? undefined;
        if (targetSpaceId && requested !== targetSpaceId) return denied;
        if (!targetSpaceId && createdSpaceId && requested !== createdSpaceId) return denied;
        if (!targetSpaceId && !createdSpaceId && id) return denied;
        const result = await readSpaceSetup({ data: requested ? { spaceId: requested } : {} });
        if (!caller.owns(ticket)) return unavailable;
        const expected = targetSpaceId ?? createdSpaceId;
        if (expected && result.kind === 'ready' && result.space?.id !== expected) return unavailable;
        return result;
      },
      choice: async (kind, id) => {
        const ticket = caller.ticket();
        if (!authorized()) return currentFailure();
        const result = await resolveSpaceSetupChoice({ data: { kind, id } });
        if (!caller.owns(ticket)) return unavailable;
        if (!('kind' in result) && result.id !== id) return unavailable;
        return result;
      },
    };
  }, [caller, csrfToken, locale, targetRealmId, targetSpaceId]);

  useEffect(() => {
    if (hydrated) claimSpaceSetupInitialSnapshot(initial);
  }, [initial, hydrated]);
  let formInitial: SetupSnapshot | SetupFailure;
  if (!hydrated) formInitial = initial;
  else if (
    ready &&
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

/** The existing home keeps its membership, following, boards and publication regions. */
export function SpaceSetupEntry({ spaceId }: { spaceId: string }) {
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
  const matches = sessionMatches(cached, session);
  const ready =
    hydrated &&
    !!queryClient &&
    matches &&
    session.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0;
  const boundary = useMemo(
    () => ({}),
    [queryClient, sessionSource, sessionRevision, dataUpdateCount, dataUpdatedAt, session.state, session.subject, session.csrfToken, spaceId],
  );
  const activeBoundary = useRef(boundary);
  activeBoundary.current = boundary;
  const current = () => {
    if (!ready || activeBoundary.current !== boundary || !queryClient || !sessionSource) return false;
    const latest = sessionSource.read();
    return (
      spaceSetupSessionSource(queryClient) === sessionSource &&
      sessionSource.snapshot() === sessionRevision &&
      sessionSource.dataUpdateCount() === dataUpdateCount &&
      sessionSource.dataUpdatedAt() === dataUpdatedAt &&
      sessionMatches(latest, session)
    );
  };
  const queryKey = [
    'space-setup-entry',
    spaceId,
    sessionSource?.id ?? null,
    sessionRevision,
    dataUpdateCount,
    dataUpdatedAt,
    session.subject ?? null,
  ] as const;
  const { data } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!current()) throw new Error('Space setup entry caller retired');
      const result = await readSpaceSetup({ data: { spaceId } });
      if (!current()) throw new Error('Space setup entry caller retired');
      return result;
    },
    enabled: personalRead.enabled && ready,
    staleTime: 0,
    retry: false,
  });
  if (!current() || data?.kind !== 'ready' || !Object.values(data.permitted).some(Boolean)) return null;
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
