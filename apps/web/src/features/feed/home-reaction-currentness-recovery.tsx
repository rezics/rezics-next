import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { browserObservation } from '../../session/observation';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { ReactionCommandRecovery } from '../../threads/thread-reactions';

type Command = Parameters<ReactionCommandRecovery['start']>[0];
type Retained = Readonly<{
  command: Command;
  occurrence: string;
  href: string;
  phase: 'pending' | 'uncertain';
}>;

/** Home owns unresolved commands independently of the advice displayed by any later page. */
function createRecovery() {
  let entries: readonly Retained[] = [];
  const listeners = new Set<() => void>();
  const acceptedListeners = new Set<() => void>();
  const publish = (next: readonly Retained[]) => {
    entries = next;
    for (const listener of listeners) listener();
  };
  const finish = (key: string) => publish(entries.filter((entry) => entry.command.key !== key));
  return {
    snapshot: () => entries,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pending: (occurrence: string) => entries.some((entry) => entry.occurrence === occurrence),
    onAccepted(listener: () => void) {
      acceptedListeners.add(listener);
      return () => {
        acceptedListeners.delete(listener);
      };
    },
    port(occurrence: string, href: string): ReactionCommandRecovery {
      return {
        start(command) {
          publish([...entries, { command, occurrence, href, phase: 'pending' }]);
        },
        uncertain(key) {
          publish(entries.map((entry) => (entry.command.key === key ? { ...entry, phase: 'uncertain' } : entry)));
        },
        accepted(key) {
          if (!entries.some((entry) => entry.command.key === key)) return;
          finish(key);
          for (const listener of acceptedListeners) listener();
        },
      };
    },
    discard: finish,
    async retry(entry: Retained) {
      if (!entries.includes(entry) || entry.phase !== 'uncertain') return false;
      publish(entries.map((candidate) => (candidate === entry ? { ...candidate, phase: 'pending' } : candidate)));
      let accepted = false;
      try {
        accepted = (await entry.command.retry()).ok;
      } catch {
        // A second lost acknowledgement retains exactly the same command.
      }
      if (accepted) {
        finish(entry.command.key);
        for (const listener of acceptedListeners) listener();
      } else
        publish(
          entries.map((candidate) =>
            candidate.command.key === entry.command.key ? { ...candidate, phase: 'uncertain' } : candidate,
          ),
        );
      return accepted;
    },
  };
}

const recoveries = new WeakMap<QueryClient, ReturnType<typeof createRecovery>>();
const noSubscribe = () => () => {};
const noSnapshot = () => undefined;

/** Retain the original intent through Home remounts within the existing browser QueryClient. */
export function useHomeReactionRecovery(onRefresh?: (() => void) | undefined) {
  const client = useContext(QueryClientContext);
  const recovery = useMemo(() => {
    if (!client) return createRecovery();
    let existing = recoveries.get(client);
    if (!existing) {
      existing = createRecovery();
      recoveries.set(client, existing);
    }
    return existing;
  }, [client]);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => recovery.onAccepted(() => refresh.current?.()), [recovery]);
  const entries = useSyncExternalStore(recovery.subscribe, recovery.snapshot, recovery.snapshot);
  const observation = useMemo(() => (client ? browserObservation(client) : undefined), [client]);
  useSyncExternalStore(
    observation?.subscribeCache ?? noSubscribe,
    observation?.getSnapshot ?? noSnapshot,
    observation?.getServerSnapshot ?? noSnapshot,
  );
  const canRetry = (command: Command) => {
    if (!client || !observation) return false;
    const browser = observation.getSnapshot();
    const state = client.getQueryState(['session']);
    const session = client.getQueryData<{ state: string; subject?: string; csrfToken?: string }>(['session']);
    return (
      browser.state === 'signed-in' &&
      state?.status === 'success' &&
      state.fetchStatus === 'idle' &&
      !state.isInvalidated &&
      session?.state === 'signed-in' &&
      browser.observation.subject === command.reader &&
      session.subject === command.reader &&
      session.csrfToken === command.credential
    );
  };
  return { recovery, entries, canRetry };
}

export function HomeReactionRecovery({
  scope,
  locale,
  onRefresh,
}: {
  scope: ReturnType<typeof useHomeReactionRecovery>;
  locale: string;
  onRefresh?: (() => void) | undefined;
}) {
  const options = { locale: locale as Locale };
  return scope.entries.length ? (
    <section aria-label={m.reaction_reactions({}, options)} className="space-y-2" data-slot="home-reaction-recovery">
      {scope.entries.map((entry) => (
        <div
          key={entry.command.key}
          data-reaction-occurrence={scope.canRetry(entry.command) ? entry.occurrence : undefined}
          aria-busy={entry.phase === 'pending'}
          className="flex flex-wrap items-center gap-2 rounded-lg border p-3"
        >
          <p role="status" className="basis-full text-sm">
            {entry.phase === 'pending' ? m.reaction_pending({}, options) : m.reaction_uncertain({}, options)}
          </p>
          {scope.canRetry(entry.command) ? (
            <a href={entry.href} className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
              {m.reaction_original_item({}, options)}
            </a>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={entry.phase === 'pending' || !scope.canRetry(entry.command)}
            onClick={() => {
              if (!scope.canRetry(entry.command)) return;
              void scope.recovery.retry(entry);
            }}
          >
            {m.editorial_retry({}, options)}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={entry.phase === 'pending'}
            onClick={() => {
              if (entry.phase === 'pending') return;
              scope.recovery.discard(entry.command.key);
              onRefresh?.();
            }}
          >
            {m.reaction_discard({}, options)}
          </Button>
        </div>
      ))}
    </section>
  ) : null;
}
