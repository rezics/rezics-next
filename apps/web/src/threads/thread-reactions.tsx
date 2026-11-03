import { Reactions, type ReactionKind } from '@rezics/ui/reactions';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { csrfHeaders } from './composer';
import { changeReaction, readReaction } from './reactions';
import { subjectReactionKinds, type ReactionFailure, type ReactionSnapshot } from './reaction-request';
import { Button } from '@rezics/ui/shadcn/button';
import type { useSession } from '../session/query';

function reactionLabels(failed: string | null) {
  return {
    upvote: m.reaction_upvote(),
    downvote: m.reaction_downvote(),
    like: m.reaction_like(),
    love: m.reaction_love(),
    laugh: m.reaction_laugh(),
    insightful: m.reaction_insightful(),
    sad: m.reaction_sad(),
    react: m.reaction_react(),
    reactions: m.reaction_reactions(),
    choose: m.reaction_choose(),
    failed: failed ?? m.reaction_failed(),
  };
}

function refusalText(failure: ReactionFailure): string {
  switch (failure.reason) {
    case 'closed':
      return m.platform_closed_message();
    case 'forbidden':
      return m.reaction_forbidden();
    case 'invalid':
      return m.reaction_invalid();
    case 'rate-limited':
      return m.reaction_rate_limited({ seconds: failure.retryAfter ?? 1 });
    default:
      return m.reaction_unavailable();
  }
}

/** Keeps a post's reaction controls inside the width left by its content. */
export function ThreadPostActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-full items-center gap-1" data-slot="thread-post-actions">
      {children}
    </div>
  );
}

// The menu stays open for another choice. A click outside it, such as the pressed chip, closes it
// so the panel does not cover the next post's React button.
function installSingleReactionMenu() {
  if (typeof document === 'undefined' || document.documentElement.dataset.reactionMenu === 'ready') return;
  document.documentElement.dataset.reactionMenu = 'ready';
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-slot="popover-content"], [data-slot="popover-trigger"]'))
      return;
    for (const trigger of document.querySelectorAll(
      '[data-slot="reactions"] [data-slot="popover-trigger"][data-popup-open]',
    )) {
      if (trigger instanceof HTMLElement) trigger.click();
    }
  });
}

export type ThreadReactionsProps = {
  target: { kind: 'thread' | 'post' | 'subject'; id: string };
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
  signedIn: boolean;
  returnTo: string;
  onMutation?: (kind: ReactionKind | null) => Promise<void>;
  personalReady?: boolean;
  reactionOrigin?: { key: string; reader: string | null; isCurrent(): boolean };
  presentation?: 'chips' | 'vote' | 'vote-plain';
  /** Feed callers reconcile one successful explicit write with the existing bounded point reader. */
  settleWithRead?: boolean;
  locale?: string;
  /** Explicitly illustrative transports for isolated stories; production callers leave this absent. */
  preparedTransport?: {
    change: typeof changeReaction;
    read: typeof readReaction;
  };
};

/** Observe the existing cache only. Remember transitions even when React batches away/back into one render. */
export function observeReactionSession(client: QueryClient | undefined) {
  // Observe sessionQuery's existing key without importing its server actions into isolated prepared renderers.
  const read = () => client?.getQueryData<ReturnType<typeof useSession>>(['session']);
  const queryState = () => client?.getQueryState(['session']);
  const identity = () => {
    const session = read();
    return JSON.stringify([
      queryState()?.status ?? 'missing',
      session?.state,
      session?.subject ?? null,
      session?.csrfToken ?? null,
    ]);
  };
  let previous = identity();
  let revision = 0;
  const snapshot = () => {
    const next = identity();
    if (next !== previous) {
      previous = next;
      revision++;
    }
    return revision;
  };
  const healthy = () => queryState()?.status === 'success';
  return {
    read,
    snapshot,
    healthy,
    serverSnapshot: () => 0,
    subscribe: (notify: () => void) =>
      client?.getQueryCache().subscribe((event) => {
        if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'session') return;
        if (
          event.type !== 'added' &&
          event.type !== 'removed' &&
          !(event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
        )
          return;
        const next = identity();
        // Success commits replace this observation, including equal results retained by structural sharing.
        // Fetch starts, invalidations and observer notifications do not replace it.
        if (next === previous && !(event.type === 'updated' && event.action.type === 'success')) return;
        previous = next;
        revision++;
        notify();
      }) ?? (() => {}),
  };
}

export function ThreadReactions(props: ThreadReactionsProps) {
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => observeReactionSession(client), [client]);
  const revision = useSyncExternalStore(observation.subscribe, observation.snapshot, observation.serverSnapshot);
  // A provider replacement is also a new caller, even if its initial session fields happen to match.
  const [provider, setProvider] = useState({ observation, visit: 0 });
  if (provider.observation !== observation) setProvider({ observation, visit: provider.visit + 1 });
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
    if (props.signedIn) installSingleReactionMenu();
  }, [props.signedIn]);

  const session = observation.read();
  // Standalone prepared views keep their explicit admission; a real client must have a known browser session.
  const sessionReady =
    !client || Boolean(observation.healthy() && session?.state === 'signed-in' && session.subject && session.csrfToken);
  const expectedReader = client && session?.state === 'signed-in' && session.subject ? session.subject : null;
  const originCurrent = props.reactionOrigin
    ? props.reactionOrigin.isCurrent() && props.reactionOrigin.reader === expectedReader
    : true;
  const admitted = hydrated && props.signedIn && (props.personalReady ?? true) && sessionReady && originCurrent;
  const key = JSON.stringify([
    provider.visit,
    revision,
    props.target.kind,
    props.target.id,
    props.signedIn,
    props.personalReady ?? true,
    props.reactionOrigin?.key ?? null,
    hydrated,
  ]);
  const desiredKey = useRef(key);
  desiredKey.current = key;
  return (
    <ReactionCaller
      key={key}
      {...props}
      admitted={admitted}
      disabled={!hydrated || !(props.personalReady ?? true) || !originCurrent || (props.signedIn && !sessionReady)}
      observation={observation}
      revision={revision}
      csrfToken={client ? (session?.csrfToken ?? '') : null}
      expectedReader={expectedReader}
      {...(props.reactionOrigin ? { reactionOrigin: props.reactionOrigin } : {})}
      isDesired={() => desiredKey.current === key}
    />
  );
}

function ReactionCaller({
  target,
  counts,
  value,
  signedIn,
  returnTo,
  onMutation,
  admitted,
  disabled,
  observation,
  revision,
  csrfToken,
  expectedReader,
  reactionOrigin,
  isDesired,
  presentation,
  settleWithRead,
  locale,
  preparedTransport,
}: ThreadReactionsProps & {
  admitted: boolean;
  disabled: boolean;
  observation: ReturnType<typeof observeReactionSession>;
  revision: number;
  csrfToken: string | null;
  expectedReader: string | null;
  reactionOrigin?: { key: string; reader: string | null; isCurrent(): boolean };
  isDesired(): boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  type Intent = { kind: ReactionKind | null; commandId: string; phase: 'write' | 'read' };
  const unresolved = useRef<Intent | null>(null);
  const [recovery, setRecovery] = useState<Intent | null>(null);
  const [recovering, setRecovering] = useState(false);
  const retrying = useRef(false);
  const epoch = useRef(0);
  const generation = epoch.current;
  type KeyboardFocus = {
    commandId: string | null;
    element: HTMLElement;
    generation: number;
    stage: 'selection' | 'retry' | 'retrying' | 'handoff';
  };
  const keyboardFocus = useRef<KeyboardFocus | null>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const focusBoundary = useRef<HTMLDivElement>(null);
  const controlled = useRef({ counts, value });
  controlled.current = { counts, value };
  const [resolved, setResolved] = useState<{
    snapshot: ReactionSnapshot;
    sourceCounts: typeof counts;
    sourceValue: typeof value;
  } | null>(null);
  // A later controlled page read replaces the point read; ordinary rerenders retain it.
  if (resolved && (resolved.sourceCounts !== counts || resolved.sourceValue !== value)) setResolved(null);
  const live = useRef(false);
  const [headers] = useState(() => (csrfToken === null ? csrfHeaders() : { 'X-CSRF-Token': csrfToken }));
  useLayoutEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () =>
    live.current &&
    admitted &&
    isDesired() &&
    observation.snapshot() === revision &&
    (reactionOrigin?.isCurrent() ?? true);

  useEffect(() => {
    const onPointerDown = () => {
      keyboardFocus.current = null;
    };
    const onFocusIn = (event: FocusEvent) => {
      const intent = keyboardFocus.current;
      if (intent && intent.stage !== 'handoff' && event.target !== intent.element) keyboardFocus.current = null;
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, []);

  function retain(intent: Intent, message: string = m.candidate_unavailable()) {
    if (!current()) return;
    const focus = keyboardFocus.current;
    const moveToRetry =
      focus?.stage === 'selection' &&
      focus.generation === generation &&
      focus.commandId === intent.commandId &&
      focus.element === document.activeElement;
    const keepRetryBoundary =
      focus?.stage === 'retrying' &&
      focus.commandId === intent.commandId &&
      focus.element === focusBoundary.current &&
      focus.element === document.activeElement;
    if (moveToRetry || keepRetryBoundary) focus!.stage = 'handoff';
    else if (focus?.commandId === intent.commandId) keyboardFocus.current = null;
    unresolved.current = intent;
    epoch.current++;
    flushSync(() => {
      setFailed(message);
      setRecovery(intent);
    });
    if (moveToRetry && focus) {
      const retry = retryButton.current;
      if (retry && current()) {
        focus.element = retry;
        focus.generation = epoch.current;
        focus.stage = 'retry';
        retry.focus();
      } else keyboardFocus.current = null;
    } else if (keepRetryBoundary && focus) {
      focus.generation = epoch.current;
      focus.element = focusBoundary.current!;
      focus.stage = 'retrying';
    }
  }

  async function submit(intent: Intent, replay: boolean) {
    const data = {
      target: target.kind,
      id: target.id,
      kind: intent.kind,
      ...(expectedReader ? { expectedReader } : {}),
    };
    let result: { ok: true } | ReactionFailure;
    try {
      result =
        intent.phase === 'read'
          ? { ok: true }
          : await (preparedTransport?.change ?? changeReaction)({
              data,
              headers: { ...headers, 'Idempotency-Key': intent.commandId },
            });
    } catch {
      if (!current()) return;
      const message = m.reaction_unavailable();
      retain(intent);
      throw new Error(message);
    }
    if (!current()) return;
    if (!result.ok) {
      if (result.reason === 'conflict') intent.phase = 'read';
      else {
        const message = refusalText(result);
        if (replay || result.reason === 'unavailable')
          retain(intent, result.reason === 'unavailable' ? undefined : message);
        else flushSync(() => setFailed(message));
        throw new Error(message);
      }
    }
    if (replay || intent.phase === 'read' || settleWithRead) {
      // A replay's receipt may describe an older slot. Only a current point read settles it.
      intent.phase = 'read';
      let snapshot: ReactionSnapshot | ReactionFailure;
      try {
        snapshot = await (preparedTransport?.read ?? readReaction)({ data, headers });
      } catch {
        snapshot = { ok: false, reason: 'unavailable' };
      }
      if (!current()) return;
      if (!snapshot.ok) {
        const message = refusalText(snapshot);
        retain(intent, snapshot.reason === 'unavailable' ? undefined : message);
        throw new Error(message);
      }
      unresolved.current = null;
      epoch.current++;
      flushSync(() => {
        setRecovery(null);
        setFailed(null);
        setRecovering(true);
        setResolved({ snapshot, sourceCounts: controlled.current.counts, sourceValue: controlled.current.value });
      });
      if (!current()) return;
      try {
        await onMutation?.(snapshot.value);
      } finally {
        if (current()) setRecovering(false);
      }
      return;
    }
    try {
      await onMutation?.(intent.kind);
    } catch (error) {
      if (current()) {
        intent.phase = 'read';
        retain(intent);
        throw error;
      }
    }
    if (!current()) return;
  }

  async function onChange(kind: ReactionKind | null) {
    if (!current() || generation !== epoch.current || unresolved.current) return;
    const commandId = crypto.randomUUID();
    const focus = keyboardFocus.current;
    if (focus?.stage === 'selection') {
      if (focus.generation === generation && focus.element === document.activeElement) focus.commandId = commandId;
      else keyboardFocus.current = null;
    }
    await submit({ kind, commandId, phase: 'write' }, false);
  }

  async function retry(intent: Intent) {
    if (!current() || unresolved.current !== intent || retrying.current) return;
    const focus = keyboardFocus.current;
    const keyboardRetry =
      focus?.stage === 'retry' &&
      focus.generation === generation &&
      focus.commandId === intent.commandId &&
      focus.element === retryButton.current &&
      focus.element === document.activeElement;
    if (keyboardRetry && focus && focusBoundary.current) {
      focus.element = focusBoundary.current;
      focus.stage = 'retrying';
      focus.element.focus();
    }
    retrying.current = true;
    setRecovering(true);
    try {
      await submit(intent, true);
    } catch {
      // The retained command and failure remain available for explicit recovery.
    } finally {
      retrying.current = false;
      if (current()) {
        flushSync(() => setRecovering(false));
        if (
          keyboardRetry &&
          focus &&
          keyboardFocus.current === focus &&
          focus.stage === 'retrying' &&
          focus.element === focusBoundary.current &&
          focus.element === document.activeElement
        ) {
          if (unresolved.current === intent && current() && retryButton.current) {
            focus.element = retryButton.current;
            focus.generation = epoch.current;
            focus.stage = 'retry';
            focus.element.focus();
          } else keyboardFocus.current = null;
        }
      }
    }
  }

  function noteKeyboardActivation(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const button = (event.target as HTMLElement).closest('button');
    if (!button || button === retryButton.current) return;
    keyboardFocus.current = { commandId: null, element: button, generation, stage: 'selection' };
  }

  return (
    // This labelled group is the stable keyboard target while recovery controls are disabled for reconciliation.
    <div
      ref={focusBoundary}
      role="group"
      aria-label={m.reaction_reactions()}
      tabIndex={-1}
      className="flex min-w-0 flex-wrap items-center gap-2"
      aria-busy={recovering}
      data-reaction-source={preparedTransport ? 'prepared' : undefined}
      onKeyDownCapture={noteKeyboardActivation}
    >
      <Reactions
        key={generation}
        counts={resolved?.snapshot.counts ?? counts}
        disabled={disabled || recovery !== null || recovering}
        {...(target.kind === 'subject' ? { kinds: subjectReactionKinds, collapse: 2 } : {})}
        labels={reactionLabels(failed)}
        locale={locale ?? getLocale()}
        {...(presentation ? { presentation } : {})}
        onChange={onChange}
        value={resolved ? resolved.snapshot.value : value}
        {...(signedIn
          ? {}
          : { signInHref: `${locale ? `/${locale}` : ''}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}` })}
      />
      {recovery ? (
        <>
          <span role="status">{failed}</span>
          <Button
            ref={retryButton}
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || recovering}
            onClick={() => void retry(recovery)}
          >
            {m.editorial_retry()}
          </Button>
        </>
      ) : null}
    </div>
  );
}
