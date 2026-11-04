import { useLayoutEffect, useRef } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { SignInPrompt } from './write-prompts';
import { useThreadWatchCurrent, type ThreadWatchProps, type ThreadWatchView } from './thread-watch-current';

export type { ThreadWatchProps } from './thread-watch-current';

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal px-3 py-2 text-start leading-snug [overflow-wrap:anywhere]';

function status(view: ThreadWatchView): string {
  const confirmation =
    view.confirmation === true
      ? m.thread_watch_confirm_started()
      : view.confirmation === false
        ? m.thread_watch_confirm_stopped()
        : '';
  if (view.refreshingAdvice) return `${confirmation} ${m.thread_watch_refreshing()}`.trim();
  if (view.phase === 'advice-refresh-failed') return `${confirmation} ${m.thread_watch_refresh_failed()}`.trim();
  switch (view.phase) {
    case 'confirmed':
      return view.confirmation === true
        ? m.thread_watch_confirm_started()
        : view.confirmation === false
          ? m.thread_watch_confirm_stopped()
          : view.watching
            ? m.thread_watch_watching()
            : m.thread_watch_not_watching();
    case 'unknown':
      return m.thread_watch_outcome_unknown();
    case 'read-failed':
      return m.thread_watch_read_failed();
    case 'refused':
      return m.thread_watch_refused();
    case 'access-lost':
      return m.thread_watch_access_lost();
    case 'unavailable':
      return m.thread_watch_unavailable();
    case 'advice-empty':
      return m.thread_watch_advice_empty();
    case 'advice-denied':
      return m.thread_watch_advice_denied();
    case 'advice-unavailable':
      return m.thread_watch_advice_unavailable();
    default:
      return m.thread_watch_checking();
  }
}

/** The existing header's private, deliberate point control. Conversation and shared actions remain independent. */
export function ThreadWatch(props: ThreadWatchProps) {
  const { visit, view } = useThreadWatchCurrent(props);
  const host = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const busy = view.phase === 'checking' || view.phase === 'sending';
  const adviceRefreshBusy = view.refreshingAdvice === true;
  const signedIn = props.sessionKnown && props.session === 'signed-in';
  const canRecover =
    view.phase === 'read-failed' ||
    view.phase === 'refused' ||
    view.phase === 'unavailable' ||
    view.phase === 'unknown';

  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !hadFocus.current || busy) return;
    // Keep keyboard recovery reachable when a pending button becomes a different deliberate action.
    if (document.activeElement === document.body || element.contains(document.activeElement))
      element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [busy, view.phase, visit]);

  return (
    <div
      ref={host}
      className="flex min-w-0 max-w-full flex-col items-start gap-1 text-sm"
      aria-busy={visit.ready && (busy || adviceRefreshBusy)}
      onFocusCapture={() => {
        hadFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) hadFocus.current = false;
      }}
    >
      {!props.sessionKnown || (signedIn && !props.viewerId) ? <p role="status">{m.thread_watch_checking()}</p> : null}
      {props.sessionKnown && !signedIn ? (
        <SignInPrompt returnTo={props.returnTo} label={m.thread_watch_anonymous()} />
      ) : null}
      {signedIn && !props.admitted ? <p role="status">{m.thread_watch_access_lost()}</p> : null}
      {signedIn && props.admitted && props.viewerId ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <p role="status" aria-live="polite" aria-atomic="true">
            {status(view)}
          </p>
          {visit.ready &&
          view.phase === 'confirmed' &&
          !adviceRefreshBusy &&
          visit.canBegin() &&
          (typeof props.initialWatching !== 'boolean' || view.watching === props.initialWatching) ? (
            <Button type="button" size="sm" className={actionClass} onClick={visit.begin}>
              {view.watching ? m.thread_watch_stop() : m.thread_watch_watch()}
            </Button>
          ) : null}
          {visit.ready && view.command && (canRecover || busy) ? (
            <Button type="button" size="sm" className={actionClass} disabled={busy} onClick={visit.retry}>
              {m.thread_watch_retry_exact()}
            </Button>
          ) : null}
          {visit.ready && (canRecover || (busy && !view.command)) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={actionClass}
              disabled={busy}
              onClick={() => void visit.read()}
            >
              {m.thread_watch_check_again()}
            </Button>
          ) : null}
          {visit.ready &&
          props.refreshAdvice &&
          ((view.phase === 'confirmed' && typeof view.confirmation === 'boolean') ||
            view.phase === 'advice-empty' ||
            view.phase === 'advice-denied' ||
            view.phase === 'advice-unavailable' ||
            view.phase === 'advice-refresh-failed') ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={actionClass}
              disabled={busy || adviceRefreshBusy}
              onClick={() => void visit.refreshAdvice()}
            >
              {m.thread_watch_refresh_advice()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {signedIn ? (
        <p className="text-xs text-muted-foreground">
          {m.thread_watch_guidance()}{' '}
          <a className="inline-flex min-h-11 items-center underline" href={`/${getLocale()}/settings#notifications`}>
            {m.thread_watch_preferences()}
          </a>
        </p>
      ) : null}
    </div>
  );
}
