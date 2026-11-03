import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { SignInPrompt } from './composer';
import {
  threadWatchNative,
  type ThreadWatchCommand,
  type ThreadWatchNative,
  type ThreadWatchState,
} from './thread-watch-native';

type WatchView =
  | { scope: string; phase: 'checking' | 'sending' }
  | { scope: string; phase: 'confirmed'; state: ThreadWatchState; confirmation?: boolean }
  | { scope: string; phase: 'read-failed' | 'refused' | 'access-lost' | 'unavailable' }
  | { scope: string; phase: 'unknown'; command: ThreadWatchCommand };

export type ThreadWatchProps = {
  threadId: string;
  session: string;
  sessionKnown: boolean;
  viewerId?: string;
  sessionStamp: string;
  admitted: boolean;
  returnTo: string;
  isCurrent?: () => boolean;
  native?: ThreadWatchNative;
};

function validState(value: ThreadWatchState | undefined): value is ThreadWatchState {
  return !!value && typeof value.watching === 'boolean' && typeof value.revision === 'string' && value.revision.length > 0;
}

export function ThreadWatch({
  threadId,
  session,
  sessionKnown,
  viewerId,
  sessionStamp,
  admitted,
  returnTo,
  isCurrent = () => true,
  native = threadWatchNative,
}: ThreadWatchProps) {
  const ready = sessionKnown && session === 'signed-in' && !!viewerId && admitted;
  const scope = JSON.stringify([threadId, viewerId ?? null, sessionStamp, admitted]);
  const scopeRef = useRef(scope);
  const nativeRef = useRef(native);
  const currentCheckRef = useRef(isCurrent);
  const sequence = useRef(0);
  const operation = useRef<object | null>(null);
  const unresolvedCommand = useRef<ThreadWatchCommand | null>(null);
  scopeRef.current = scope;
  nativeRef.current = native;
  currentCheckRef.current = isCurrent;

  const [storedView, setView] = useState<WatchView>();
  const view: WatchView =
    storedView?.scope === scope
      ? storedView
      : { scope, phase: ready ? 'checking' : admitted ? 'checking' : 'access-lost' };

  const responseIsCurrent = (requestScope: string, requestSequence: number, requestNative: ThreadWatchNative) =>
    scopeRef.current === requestScope &&
    sequence.current === requestSequence &&
    nativeRef.current === requestNative &&
    currentCheckRef.current();

  const readStatus = useCallback(async () => {
    if (!ready || !viewerId || operation.current || !currentCheckRef.current()) return;
    const requestScope = scope;
    const requestNative = native;
    const requestSequence = ++sequence.current;
    const ticket = {};
    operation.current = ticket;
    unresolvedCommand.current = null;
    setView({ scope: requestScope, phase: 'checking' });
    try {
      const result = await requestNative.read(
        Object.freeze({ threadId, viewerId, sessionStamp, fetch: Object.freeze({ cache: 'no-store' as const }) }),
      );
      if (!responseIsCurrent(requestScope, requestSequence, requestNative)) return;
      if (result.kind === 'confirmed' && validState(result.state))
        setView({ scope: requestScope, phase: 'confirmed', state: result.state });
      else if (result.kind === 'access-lost') setView({ scope: requestScope, phase: 'access-lost' });
      else if (result.kind === 'unavailable') setView({ scope: requestScope, phase: 'unavailable' });
      else setView({ scope: requestScope, phase: 'read-failed' });
    } catch {
      if (responseIsCurrent(requestScope, requestSequence, requestNative))
        setView({ scope: requestScope, phase: 'read-failed' });
    } finally {
      if (operation.current === ticket) operation.current = null;
    }
  }, [native, ready, scope, sessionStamp, threadId, viewerId]);

  useEffect(() => {
    if (!ready) {
      sequence.current++;
      operation.current = null;
      unresolvedCommand.current = null;
      return;
    }
    void readStatus();
    return () => {
      sequence.current++;
      operation.current = null;
      unresolvedCommand.current = null;
    };
  }, [readStatus, ready]);

  const send = async (command: ThreadWatchCommand, retry: boolean) => {
    if (
      !ready ||
      !isCurrent() ||
      operation.current ||
      scopeRef.current !== scope ||
      (retry && unresolvedCommand.current !== command)
    )
      return;
    const requestScope = scope;
    const requestNative = native;
    const requestSequence = ++sequence.current;
    const ticket = {};
    operation.current = ticket;
    unresolvedCommand.current = command;
    setView({ scope: requestScope, phase: 'sending' });
    try {
      const result = await requestNative.set(command);
      if (!responseIsCurrent(requestScope, requestSequence, requestNative)) return;
      if (result.kind === 'confirmed' && validState(result.state) && result.state.watching === command.watching) {
        unresolvedCommand.current = null;
        setView({ scope: requestScope, phase: 'confirmed', state: result.state, confirmation: command.watching });
      } else if (result.kind === 'refused' && result.reason === 'access-lost') {
        unresolvedCommand.current = null;
        setView({ scope: requestScope, phase: 'access-lost' });
      } else if (result.kind === 'refused' && result.reason === 'unavailable') {
        unresolvedCommand.current = null;
        setView({ scope: requestScope, phase: 'unavailable' });
      } else if (result.kind === 'refused') {
        unresolvedCommand.current = null;
        setView({ scope: requestScope, phase: 'refused' });
      } else {
        setView({ scope: requestScope, phase: 'unknown', command });
      }
    } catch {
      if (responseIsCurrent(requestScope, requestSequence, requestNative))
        setView({ scope: requestScope, phase: 'unknown', command });
    } finally {
      if (operation.current === ticket) operation.current = null;
    }
  };

  const begin = (state: ThreadWatchState) => {
    if (!ready || operation.current || !isCurrent()) return;
    const command = Object.freeze({
      threadId,
      viewerId: viewerId!,
      sessionStamp,
      watching: !state.watching,
      expectedRevision: state.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    void send(command, false);
  };

  const retryExact = (command: ThreadWatchCommand) => void send(command, true);

  return (
    <div
      className="flex min-w-0 flex-col items-start gap-1 text-sm"
      aria-busy={view.phase === 'checking' || view.phase === 'sending'}
    >
      {!sessionKnown ? <p role="status">{m.thread_watch_checking()}</p> : null}
      {sessionKnown && session === 'signed-in' && !viewerId ? <p role="status">{m.thread_watch_checking()}</p> : null}
      {sessionKnown && session !== 'signed-in' ? (
        <SignInPrompt returnTo={returnTo} label={m.thread_watch_anonymous()} />
      ) : null}
      {sessionKnown && session === 'signed-in' && !admitted ? <p role="status">{m.thread_watch_access_lost()}</p> : null}
      {ready && view.phase === 'checking' ? <p role="status">{m.thread_watch_checking()}</p> : null}
      {ready && view.phase === 'sending' ? <p role="status">{m.thread_watch_checking()}</p> : null}
      {ready && view.phase === 'confirmed' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">
            {view.confirmation === true
              ? m.thread_watch_confirm_started()
              : view.confirmation === false
                ? m.thread_watch_confirm_stopped()
                : view.state.watching
                  ? m.thread_watch_watching()
                  : m.thread_watch_not_watching()}
          </p>
          <Button type="button" size="sm" onClick={() => begin(view.state)}>
            {view.state.watching ? m.thread_watch_stop() : m.thread_watch_watch()}
          </Button>
        </div>
      ) : null}
      {ready && view.phase === 'unknown' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">{m.thread_watch_outcome_unknown()}</p>
          <Button type="button" size="sm" onClick={() => retryExact(view.command)}>
            {m.thread_watch_retry_exact()}
          </Button>
        </div>
      ) : null}
      {ready && view.phase === 'read-failed' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">{m.thread_watch_read_failed()}</p>
          <Button type="button" size="sm" onClick={() => void readStatus()}>
            {m.thread_watch_check_again()}
          </Button>
        </div>
      ) : null}
      {ready && view.phase === 'refused' ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status">{m.thread_watch_refused()}</p>
          <Button type="button" size="sm" onClick={() => void readStatus()}>
            {m.thread_watch_check_again()}
          </Button>
        </div>
      ) : null}
      {ready && view.phase === 'access-lost' ? <p role="status">{m.thread_watch_access_lost()}</p> : null}
      {ready && view.phase === 'unavailable' ? <p role="status">{m.thread_watch_unavailable()}</p> : null}
      {sessionKnown && session === 'signed-in' ? (
        <p className="text-xs text-muted-foreground">
          {m.thread_watch_guidance()}{' '}
          <a className="underline" href="/settings#notifications">
            {m.thread_watch_preferences()}
          </a>
        </p>
      ) : null}
    </div>
  );
}
