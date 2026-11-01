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
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { csrfHeaders } from './composer';
import { changeReaction } from './reactions';
import { subjectReactionKinds, type ReactionFailure } from './reaction-request';
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

type ThreadReactionsProps = {
  target: { kind: 'thread' | 'post' | 'subject'; id: string };
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
  signedIn: boolean;
  returnTo: string;
  onMutation?: (kind: ReactionKind | null) => Promise<void>;
  personalReady?: boolean;
  reactionOrigin?: { key: string; reader: string | null; isCurrent(): boolean };
};

/** Observe the existing cache only. Remember transitions even when React batches away/back into one render. */
function observeReactionSession(client: QueryClient | undefined) {
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
        if (next === previous) return;
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
    !client ||
    Boolean(observation.healthy() && session?.state === 'signed-in' && session.subject && session.csrfToken);
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
      disabled={
        !hydrated ||
        !(props.personalReady ?? true) ||
        !originCurrent ||
        (props.signedIn && !sessionReady)
      }
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

  async function onChange(kind: ReactionKind | null) {
    if (!current()) return;
    let result: { ok: true } | ReactionFailure;
    try {
      result = await changeReaction({
        data: {
          target: target.kind,
          id: target.id,
          kind,
          ...(expectedReader ? { expectedReader } : {}),
        },
        headers,
      });
    } catch {
      if (!current()) return;
      const message = m.reaction_unavailable();
      flushSync(() => setFailed(message));
      throw new Error(message);
    }
    if (!current()) return;
    if (!result.ok) {
      const message = refusalText(result);
      flushSync(() => setFailed(message));
      throw new Error(message);
    }
    try {
      await onMutation?.(kind);
    } catch (error) {
      if (current()) throw error;
    }
    if (!current()) return;
  }

  return (
    <Reactions
      counts={counts}
      disabled={disabled}
      {...(target.kind === 'subject' ? { kinds: subjectReactionKinds, collapse: 2 } : {})}
      labels={reactionLabels(failed)}
      locale={getLocale()}
      onChange={onChange}
      value={value}
      {...(signedIn ? {} : { signInHref: `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}` })}
    />
  );
}
