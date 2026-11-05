import { createSpaceEntryCommands, type SpaceEntryCommands } from './space-entry/commands';
import { SpaceEntryControls } from './space-entry/controls';
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, QueryClient, QueryClientContext } from '@tanstack/react-query';
import { AnonymousSessionContext, sessionQuery } from '../session/query';
import { personalRead } from '../kernel/query';
import { normalizeSessionObservation, subscribeBrowserSession, sessionStateSnapshot } from '../session/browser-state';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { operationIsAdmitted } from '../kernel/exposure';
import { CollectionFollowControl } from './collection-context/follow';
import { AccountFollowControl } from './account-context/follow';
import { writeCollectionFollow } from './collection-context/actions';
import { collectionFollowSource } from './collection-context/schema';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { changeQuestionBoundRating } from '../features/pages/rating-actions';
import { discoveryKey, type DiscoveryHit, type DiscoveryRequest, type DiscoveryState } from './discovery';
import type { SubjectLibraryMutation, SubjectLibraryMutationResponse } from '../library/subject-slot';
import type { QuestionBoundRatingInput } from '../features/pages/rating-actions';
import type { ExpectedReader } from '../session/expected-reader';
import type { FollowWriteInput, FollowWriteResult } from '../library/follow-records';
import { QUESTION } from '../features/pages/subject-ratings';
import {
  readDiscoveryPersonalPage,
  type DiscoveryBoundRequest,
  type DiscoveryBoundPage,
} from './discovery-personal-server';
import { discoveryExposureKey } from './discovery-personal-capabilities';
import { DiscoveryPersonalControls, DiscoveryScoreControls } from './discovery-personal-controls';
import {
  createDiscoveryCommandRegistry,
  createDiscoveryPersonalPage,
  type DiscoveryPersonalObservation,
  type DiscoveryPersonalPage,
} from './discovery-personal-state';

const previewClient = new QueryClient();
const registries = new WeakMap<
  QueryClient,
  { id: string; commands: ReturnType<typeof createDiscoveryCommandRegistry> }
>();
function commandRegistry(client: QueryClient) {
  let registry = registries.get(client);
  if (!registry) {
    registry = { id: crypto.randomUUID(), commands: createDiscoveryCommandRegistry() };
    registries.set(client, registry);
  }
  return registry;
}
type Mounted = DiscoveryBoundPage & {
  page: DiscoveryPersonalPage;
  observation: DiscoveryPersonalObservation;
  suppressed: boolean;
  spaceCommands: SpaceEntryCommands;
  reviewedRow?: string;
  refresh: (suppress?: boolean, rowKey?: string) => Promise<void>;
};
type Focus = { element: HTMLElement; row: string | undefined; index: number; x: number; y: number };

/** Public loader data stays public. The mounted reader obtains one complete private page through a POST seam. */
export function useDiscoveryPersonalResults(input: {
  source: DiscoveryState | undefined;
  request: DiscoveryRequest | undefined;
  locale: string;
  returnTo: string;
  enabled: boolean;
  read?: (options: { data: DiscoveryBoundRequest; signal: AbortSignal }) => Promise<DiscoveryBoundPage>;
  writeFollow?: (options: {
    data: FollowWriteInput & ExpectedReader;
    headers: Record<string, string>;
  }) => Promise<FollowWriteResult>;
  writeEntry?: (command: SubjectLibraryMutation & ExpectedReader) => Promise<SubjectLibraryMutationResponse>;
  writeSpaceFollow?: (command: FollowWriteInput & ExpectedReader) => Promise<FollowWriteResult>;
  writeVote?: (command: QuestionBoundRatingInput) => Promise<'successful' | 'rejected' | 'uncertain'>;
}) {
  const connected = useContext(QueryClientContext);
  const anonymous = useContext(AnonymousSessionContext);
  const client = connected ?? previewClient;
  const subscribeSession = useCallback(
    (listener: () => void) =>
      subscribeBrowserSession(
        client,
        listener,
        connected && personalRead.enabled ? () => client.ensureQueryData(sessionQuery) : undefined,
        !!connected && !anonymous,
      ),
    [client, connected, anonymous],
  );
  const sessionSnapshot = useCallback(() => sessionStateSnapshot(client), [client]);
  const sessionState = useSyncExternalStore(subscribeSession, sessionSnapshot, () => undefined);
  const session = anonymous
    ? { state: 'signed-out' as const, csrfToken: null, subject: null }
    : sessionState?.status === 'success'
      ? normalizeSessionObservation(sessionState.data)
      : { state: 'unknown' as const, csrfToken: null, subject: null };
  const exposureLifetime = viewerExposureLifetime(client);
  const exposure = useSyncExternalStore(
    exposureLifetime.subscribe,
    exposureLifetime.getSnapshot,
    exposureLifetime.getServerSnapshot,
  );
  const exposureOwner = exposure.state === 'signed-in' ? exposure.observation : undefined;
  const exposureQuery = viewerExposureQuery(exposureOwner);
  const exposureResult = useQuery({ ...exposureQuery, enabled: !!connected && !!exposureOwner }, client);
  const admitted = exposureResult.data;
  const requestKey = JSON.stringify(input.request);
  const signature = JSON.stringify([
    input.enabled,
    input.locale,
    requestKey,
    session.state,
    session.subject,
    session.csrfToken,
    exposureOwner,
    admitted,
  ]);
  const regionRef = useRef<HTMLElement | null>(null);
  const pendingFocus = useRef<Focus | null>(null);
  const episodeRef = useRef<{
    signature: string;
    source: DiscoveryState | undefined;
    active: boolean;
    retired: boolean;
    abort: AbortController;
    id: string;
  } | null>(null);
  if (!episodeRef.current || episodeRef.current.signature !== signature || episodeRef.current.source !== input.source) {
    if (episodeRef.current) {
      pendingFocus.current = null;
      episodeRef.current.active = false;
      episodeRef.current.retired = true;
    }
    episodeRef.current = {
      signature,
      source: input.source,
      active: true,
      retired: false,
      abort: new AbortController(),
      id: crypto.randomUUID(),
    };
  }
  const episode = episodeRef.current;
  const [mounted, setMounted] = useState<{ owner: typeof episode; value: Mounted } | null>(null);
  const read = input.read ?? readDiscoveryPersonalPage;
  const nativeRegistry = commandRegistry(client);
  function captureFocus() {
    if (typeof document === 'undefined') return;
    const region = regionRef.current;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !region?.contains(active)) return;
    const rows = [...region.querySelectorAll<HTMLElement>('[data-discovery-personal-row]')];
    const row = active.closest<HTMLElement>('[data-discovery-personal-row]');
    pendingFocus.current = {
      element: active,
      row: row?.dataset.discoveryPersonalRow,
      index: row ? rows.indexOf(row) : 0,
      x: window.scrollX,
      y: window.scrollY,
    };
  }
  useLayoutEffect(() => {
    const focus = pendingFocus.current;
    pendingFocus.current = null;
    const region = regionRef.current;
    if (!focus || !region) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== focus.element &&
      active !== document.body &&
      !region.contains(active)
    )
      return;
    if (!focus.element.isConnected) {
      const rows = [...region.querySelectorAll<HTMLElement>('[data-discovery-personal-row]')];
      const row =
        rows.find((row) => row.dataset.discoveryPersonalRow === focus.row) ??
        rows[Math.min(focus.index, rows.length - 1)];
      const destination =
        row?.querySelector<HTMLElement>('button, select, a, input') ??
        region.querySelector<HTMLElement>('[data-discovery-restart]') ??
        region;
      destination.focus({ preventScroll: true });
    }
    window.scrollTo(focus.x, focus.y);
  }, [mounted, episode]);

  useEffect(() => {
    if (episode.retired || episodeRef.current !== episode) return;
    episode.active = true;
    if (episode.abort.signal.aborted) episode.abort = new AbortController();
    const lifetime = episode.abort;
    let current: Mounted | undefined;
    const owns = () => {
      const query = client.getQueryState(sessionQuery.queryKey);
      const now = query?.status === 'success' ? normalizeSessionObservation(query.data) : undefined;
      const latest = exposureLifetime.getSnapshot();
      return (
        episode.active &&
        !lifetime.signal.aborted &&
        episodeRef.current === episode &&
        now?.state === 'signed-in' &&
        now.subject === session.subject &&
        now.csrfToken === session.csrfToken &&
        latest.state === 'signed-in' &&
        latest.observation === exposureOwner &&
        client.getQueryData(exposureQuery.queryKey) === admitted
      );
    };
    const ready =
      input.enabled &&
      input.request &&
      input.source &&
      session.state === 'signed-in' &&
      session.subject &&
      session.csrfToken &&
      exposureOwner &&
      admitted?.subject === session.subject;
    if (!ready)
      return () => {
        episode.active = false;
        lifetime.abort();
      };
    const request = structuredClone(input.request!);
    const binding = { expectedReader: session.subject!, expectedCredential: session.csrfToken! };
    const load = (signal: AbortSignal) => read({ data: { ...binding, request, locale: input.locale }, signal });
    const install = (result: DiscoveryBoundPage, reviewedRow?: string) => {
      if (!owns()) return;
      current?.page.dispose();
      current?.spaceCommands.dispose();
      // Exposure observations are independent of the native entry facts and must agree before mounting writes.
      const accepted = result.capabilities?.exposure === discoveryExposureKey(admitted!.admitted);
      const state = structuredClone<DiscoveryState>(
        !accepted && result.state.status === 'ready'
          ? {
              ...result.state,
              page: {
                ...result.state.page,
                viewerFacts: null,
                collectionFollows: { state: 'unavailable', reason: 'identity' },
                accountFollows: { state: 'unavailable', reason: 'identity' },
              },
            }
          : result.state,
      );
      if (!accepted && state.status === 'ready') delete state.page.spaceEntries;
      const viewer =
        state.status === 'ready' && state.page.viewerFacts?.state === 'current' ? state.page.viewerFacts : null;
      const observation: DiscoveryPersonalObservation = {
        scope: {
          viewer: binding.expectedReader,
          credential: binding.expectedCredential,
          locale: input.locale,
          page: crypto.randomUUID(),
          request: requestKey,
          registry: nativeRegistry.id,
          generation:
            state.status === 'ready'
              ? JSON.stringify([state.page.as_of, state.page.next, state.page.kinds])
              : state.status,
          admission: JSON.stringify([exposureOwner, result.capabilities]),
        },
        targets:
          viewer?.rows.flatMap((row) =>
            row.resolvedSubjectId
              ? [
                  {
                    rowKey: row.rowKey,
                    originalSubjectId: row.subjectId,
                    subjectId: row.resolvedSubjectId,
                    entry: row.entry,
                    vote: row.vote,
                    question: viewer.question,
                  },
                ]
              : [],
          ) ?? [],
      };
      let refreshed: DiscoveryBoundPage | undefined;
      // The controlled lifetime includes repeated question evidence; refuse the private overlay if it exceeds its bound.
      if (
        observation.targets.length > 100 ||
        new TextEncoder().encode(JSON.stringify(observation.targets)).byteLength > 65536 ||
        new TextEncoder().encode(
          JSON.stringify(
            observation.targets.map((target) => ({ rowKey: target.rowKey, subjectId: target.originalSubjectId })),
          ),
        ).byteLength > 16384
      ) {
        observation.targets = [];
        if (state.status === 'ready')
          state.page = {
            ...state.page,
            viewerFacts: { state: 'unavailable', reason: 'response_limit', retryable: false },
            collectionFollows: { state: 'unavailable', reason: 'native' },
            accountFollows: { state: 'unavailable', reason: 'native' },
          };
      }
      const page = createDiscoveryPersonalPage({
        observation,
        observe: () => (owns() ? observation : undefined),
        registry: nativeRegistry.commands,
        retirePrivate: () => {
          if (!owns() || !current) return;
          setMounted({ owner: episode, value: { ...current, suppressed: true } });
        },
        refresh: async (signal) => {
          refreshed = await load(signal);
          signal.throwIfAborted();
          return refreshed.state;
        },
        publish: () => {
          if (refreshed && owns()) {
            captureFocus();
            install(refreshed);
          }
        },
      });
      const installed: Mounted = {
        state,
        capabilities: accepted ? result.capabilities : null,
        page,
        observation,
        suppressed: false,
        ...(reviewedRow ? { reviewedRow } : {}),
        refresh: async (suppress = false, rowKey) => {
          if (!owns() || current !== installed || (rowKey && !installed.page.current())) return;
          const active = document.activeElement;
          if (
            !rowKey ||
            (active instanceof HTMLElement &&
              active.closest<HTMLElement>('[data-discovery-personal-row]')?.dataset.discoveryPersonalRow === rowKey)
          )
            captureFocus();
          if (suppress) {
            installed.suppressed = true;
            setMounted({ owner: episode, value: { ...installed } });
          }
          let fresh: DiscoveryBoundPage;
          try {
            fresh = await load(lifetime.signal);
          } catch {
            fresh = { state: { status: 'unavailable' }, capabilities: null };
          }
          if (!owns() || current !== installed) return;
          if (fresh.state.status === 'unavailable' && installed.state.status === 'ready') {
            const { spaceEntries: _, ...publicPage } = installed.state.page;
            fresh = { state: { status: 'ready', page: { ...publicPage, viewerFacts: null } }, capabilities: null };
          }
          install(fresh, !suppress ? rowKey : undefined);
        },
        spaceCommands: createSpaceEntryCommands({
          reader: binding,
          current: () => owns() && current === installed,
          registry: nativeRegistry.commands,
          write: async (command) => {
            if (!owns() || current !== installed) return { ok: false, reason: 'unavailable' };
            if (input.writeSpaceFollow) return input.writeSpaceFollow(command);
            const { writeSearchSpaceFollow } = await import('./space-entry/server');
            if (!owns() || current !== installed) return { ok: false, reason: 'unavailable' };
            return writeSearchSpaceFollow({ data: command });
          },
          suppress: () => {
            if (!owns() || current !== installed) return;
            installed.suppressed = true;
            setMounted({ owner: episode, value: { ...installed } });
          },
          refresh: () => installed.refresh(),
        }),
      };
      current = installed;
      setMounted({ owner: episode, value: current });
    };
    // An observed cache retirement is terminal even if the old reader/exposure object returns before React renders.
    const unsubscribe = client.getQueryCache().subscribe(() => {
      if (!owns() && episode.active) {
        pendingFocus.current = null;
        episode.retired = true;
        episode.active = false;
        episode.abort.abort();
        current?.page.dispose();
        current?.spaceCommands.dispose();
        setMounted(null);
      }
    });
    void load(lifetime.signal)
      .then(install)
      .catch(() => {
        if (owns()) install({ state: { status: 'unavailable' }, capabilities: null });
      });
    return () => {
      episode.active = false;
      lifetime.abort();
      current?.page.dispose();
      current?.spaceCommands.dispose();
      unsubscribe();
    };
  }, [episode]);

  const value = mounted?.owner === episode && episode.active ? mounted.value : undefined;
  const source = value?.state ?? input.source;
  const publicDisplayPage =
    source?.status === 'ready'
      ? (() => {
          const { spaceEntries, ...page } = source.page;
          return {
            ...page,
            ...(spaceEntries?.reader === null ? { spaceEntries } : {}),
            viewerFacts: null,
            collectionFollows: { state: 'unavailable' as const, reason: 'identity' as const },
            accountFollows: { state: 'unavailable' as const, reason: 'identity' as const },
          };
        })()
      : undefined;
  const display: DiscoveryState | undefined =
    source?.status === 'ready' && (!value || value.suppressed) ? { ...source, page: publicDisplayPage! } : source;
  const renderPersonal = (hit: DiscoveryHit, title: string) => {
    if (hit.summary.kind === 'space') {
      const privatePage =
        value?.state.status === 'ready' && !value.suppressed ? value.state.page.spaceEntries : undefined;
      const publicPage =
        input.source?.status === 'ready' && input.source.page.spaceEntries?.reader === null
          ? input.source.page.spaceEntries
          : undefined;
      const row = (
        session.state === 'signed-out' ? publicPage : privatePage?.reader === session.subject ? privatePage : undefined
      )?.rows.find((row) => row.id === hit.key.id);
      return (
        <SpaceEntryControls
          key={`${value?.observation.scope.page ?? episode.id}:${hit.key.id}`}
          id={hit.key.id}
          row={row}
          locale={input.locale}
          returnTo={input.returnTo}
          signedOut={session.state === 'signed-out'}
          commands={value && !value.suppressed ? value.spaceCommands : undefined}
        />
      );
    }
    const options = { locale: locales.find((locale) => locale === input.locale) ?? 'en' };
    if (hit.summary.kind === 'collection' || hit.summary.kind === 'account') {
      const Control = hit.summary.kind === 'account' ? AccountFollowControl : CollectionFollowControl;
      const target = hit.summary.kind === 'account' ? hit.summary.value.context?.followTarget : undefined;
      const expected =
        hit.summary.kind === 'collection'
          ? { id: hit.key.id, type: 'collection', source: collectionFollowSource(hit.summary.value.card) }
          : target?.state === 'available'
            ? { id: target.id, type: 'subject', source: target.source }
            : undefined;
      const follows =
        value?.state.status === 'ready'
          ? hit.summary.kind === 'account'
            ? value.state.page.accountFollows
            : value.state.page.collectionFollows
          : undefined;
      const row =
        follows?.state === 'current' && follows.accountId === value?.observation.scope.viewer
          ? follows.rows.find(
              (row) =>
                expected &&
                row.targetId === expected.id &&
                row.targetType === expected.type &&
                row.source === expected.source,
            )
          : undefined;
      if (
        value &&
        !value.suppressed &&
        value.capabilities &&
        operationIsAdmitted('follow.get', admitted?.admitted) &&
        row
      )
        return (
          <Control
            key={`${value.observation.scope.page}:${discoveryKey(hit)}:${row.source}`}
            row={{
              ...row,
              actions: {
                follow: row.actions.follow && operationIsAdmitted('follow.put', admitted?.admitted),
                unfollow: row.actions.unfollow && operationIsAdmitted('follow.delete', admitted?.admitted),
              },
            }}
            title={title}
            reviewed={value.reviewedRow === discoveryKey(hit)}
            refresh={(suppress: boolean) => value.refresh(suppress, discoveryKey(hit))}
            rowKey={discoveryKey(hit)}
            binding={{
              expectedReader: value.observation.scope.viewer,
              expectedCredential: value.observation.scope.credential,
            }}
            lifetime={value.observation.scope.page}
            current={() => value.page.current() && !value.suppressed}
            locale={input.locale}
            write={(data) =>
              (input.writeFollow ?? writeCollectionFollow)({
                data,
                headers: { 'X-CSRF-Token': data.expectedCredential },
              })
            }
          />
        );
      if (hit.summary.kind === 'account' && !expected)
        return <p role="status">{m.library_follow_unavailable({}, options)}</p>;
      return session.state === 'signed-out' ? (
        <a
          className="inline-flex min-h-11 items-center text-primary underline"
          href={`/auth/sign-in?return_to=${encodeURIComponent(input.returnTo)}`}
        >
          {m.account_sign_in({}, options)}
        </a>
      ) : (
        <p role="status">{m.library_follow_unavailable({}, options)}</p>
      );
    }
    const target = value?.observation.targets.find((target) => target.rowKey === discoveryKey(hit));
    if (!value || !target) {
      const state =
        session.state === 'signed-out'
          ? 'signed-out'
          : session.state === 'unknown' ||
              (session.state === 'signed-in' &&
                !value &&
                (exposureResult.isPending || admitted?.subject === session.subject))
            ? 'unknown'
            : 'unavailable';
      return state === 'signed-out' ? (
        <a
          className="inline-flex min-h-11 items-center text-primary underline"
          href={`/auth/sign-in?return_to=${encodeURIComponent(input.returnTo)}`}
        >
          {m.account_sign_in({}, options)}
        </a>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          {state === 'unknown'
            ? m.discovery_personal_unknown({}, options)
            : m.discovery_personal_unavailable({}, options)}
        </p>
      );
    }
    const entry = value.capabilities?.entries[hit.key.kind] ?? { state: 'unavailable' as const };
    const vote = !value.capabilities
      ? { state: 'unavailable' as const }
      : !value.capabilities.vote
        ? { state: 'concealed' as const }
        : hit.summary.kind !== 'subject' ||
            !hit.summary.value.creativeWork ||
            !target.question ||
            target.question.id !== QUESTION
          ? { state: 'unsupported' as const }
          : { state: 'ready' as const, set: true, clear: true };
    return (
      <div className="space-y-3">
        <DiscoveryPersonalControls
          key={`entry:${value.observation.scope.page}:${target.rowKey}`}
          page={value.page}
          target={target}
          capability={entry}
          locale={input.locale}
          title={title}
          returnTo={input.returnTo}
          suppressed={value.suppressed}
          write={async (command) => {
            const write =
              input.writeEntry ??
              (async (data) => {
                const { mutateSubjectLibrarySlot } = await import('../library/subject-slot-actions');
                if (!value.page.current()) return { result: 'unavailable' as const };
                return mutateSubjectLibrarySlot({ data });
              });
            if (!value.page.current()) return { result: 'unavailable' };
            return write({
              ...command,
              expectedReader: value.observation.scope.viewer,
              expectedCredential: value.observation.scope.credential,
            });
          }}
        />
        <DiscoveryScoreControls
          key={`vote:${value.observation.scope.page}:${target.rowKey}`}
          page={value.page}
          target={target}
          capability={vote}
          locale={input.locale}
          returnTo={input.returnTo}
          suppressed={value.suppressed}
          write={(command) => {
            const data = {
              ...command,
              expectedReader: value.observation.scope.viewer,
              expectedCredential: value.observation.scope.credential,
            };
            return input.writeVote ? input.writeVote(data) : changeQuestionBoundRating({ data });
          }}
        />
      </div>
    );
  };
  return { state: display, renderPersonal: input.enabled ? renderPersonal : undefined, regionRef };
}
