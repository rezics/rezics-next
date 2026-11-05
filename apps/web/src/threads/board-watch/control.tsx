import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { SignInPrompt } from '../write-prompts';
import type { BoardOpeningReactionOrigin } from '../board-opening';
import type { BoardWatchNative } from './contract';
import { boardWatchNative } from './native';
import { BoardWatchVisit, type BoardWatchView, type BoardWatchVisitBinding } from './visit';

export type BoardWatchSession = Readonly<{
  state: string;
  subject?: string | null;
  csrfToken?: string | null;
}>;

export type BoardWatchControlProps = Readonly<{
  boardId: string;
  returnTo: string;
  session: BoardWatchSession;
  authority: Pick<BoardOpeningReactionOrigin, 'key' | 'isCurrent'>;
  native?: BoardWatchNative;
}>;

const actionClass =
  'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal px-3 py-2 text-start leading-snug [overflow-wrap:anywhere]';

function phaseMessage(view: BoardWatchView): string {
  if (view.command === 'sending') return m.board_watch_sending();
  if (view.phase === 'checking') return m.board_watch_checking();
  if (view.phase === 'read-failed' || view.phase === 'unknown') return m.board_watch_outcome_unknown();
  if (view.phase === 'conflict' || view.command === 'conflict') return m.board_watch_conflict();
  if (view.phase === 'denied') return m.board_watch_access_lost();
  if (view.phase === 'unavailable') return m.board_watch_unavailable();
  if (view.phase === 'retired') return '';
  return view.page?.viewer.watching ? m.board_watch_current_watching() : m.board_watch_current_not_watching();
}

function SignedInBoardWatchControl({
  boardId,
  accountId,
  csrfToken,
  authority,
  native = boardWatchNative,
}: {
  boardId: string;
  accountId: string;
  csrfToken: string;
  authority: BoardWatchControlProps['authority'];
  native?: BoardWatchNative;
}) {
  const value: BoardWatchVisitBinding = {
    boardId,
    accountId,
    csrfToken,
    authorityKey: authority.key,
    isCurrent: authority.isCurrent,
    native,
  };
  const latest = useRef<{ value: BoardWatchVisitBinding }>({ value });
  latest.current = { value };
  const visitRef = useRef<BoardWatchVisit | null>(null);
  if (!visitRef.current?.matches(value)) {
    visitRef.current?.retire();
    visitRef.current = new BoardWatchVisit(value, () => latest.current);
  }
  const visit = visitRef.current;
  const view = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const host = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const busy = view.phase === 'checking' || view.command === 'sending';
  const advice = view.page
    ? view.page.viewer.watching
      ? view.page.actions.unwatch
      : view.page.actions.watch
    : 'not-applicable';
  const canAct = visit.canBegin();
  const canInspect =
    ['read-failed', 'unknown', 'conflict', 'unavailable', 'denied'].includes(view.phase) ||
    view.command === 'unknown' ||
    (view.phase === 'current' && advice === 'denied');

  useEffect(() => visit.connect(), [visit]);
  useEffect(() => {
    const element = host.current;
    if (!element || !hadFocus.current || busy) return;
    if (document.activeElement === document.body || element.contains(document.activeElement))
      element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [busy, view.phase, view.command, visit]);

  if (view.phase === 'retired') return null;
  return (
    <div
      ref={host}
      className="flex min-w-0 max-w-full flex-col items-start gap-1 text-sm"
      aria-busy={busy}
      data-slot="board-watch-control"
      onFocusCapture={() => {
        hadFocus.current = true;
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) hadFocus.current = false;
      }}
    >
      <p role="status" aria-live="polite" aria-atomic="true">
        {phaseMessage(view)}
      </p>
      {view.command === 'acknowledged' ? (
        <p role="status" aria-live="polite">
          {m.board_watch_command_acknowledged()}
        </p>
      ) : null}
      {view.phase === 'current' && advice === 'denied' ? <p role="status">{m.board_watch_read_only()}</p> : null}
      {canAct ? (
        <Button type="button" size="sm" className={actionClass} onClick={visit.begin}>
          {view.page?.viewer.watching ? m.board_watch_stop() : m.board_watch_start()}
        </Button>
      ) : null}
      {view.command === 'unknown' ? (
        <Button type="button" size="sm" className={actionClass} disabled={busy} onClick={visit.retry}>
          {m.board_watch_retry_exact()}
        </Button>
      ) : null}
      {canInspect ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={actionClass}
          disabled={busy}
          onClick={() => void visit.read()}
        >
          {m.board_watch_check_again()}
        </Button>
      ) : null}
      {view.phase === 'current' && view.command === 'unknown' ? (
        <p className="text-xs text-muted-foreground">{m.board_watch_outcome_unknown()}</p>
      ) : null}
      {view.phase === 'conflict' ? (
        <p className="text-xs text-muted-foreground">{m.board_watch_inspect_conflict()}</p>
      ) : null}
    </div>
  );
}

export function BoardWatchControl(props: BoardWatchControlProps) {
  if (props.session.state === 'signed-out')
    return <SignInPrompt returnTo={props.returnTo} label={m.board_watch_sign_in()} compact />;
  if (
    props.session.state !== 'signed-in' ||
    typeof props.session.subject !== 'string' ||
    props.session.subject.length === 0 ||
    typeof props.session.csrfToken !== 'string' ||
    props.session.csrfToken.length === 0
  )
    return (
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground" data-slot="board-watch-unready">
        {props.session.state === 'unavailable' ? m.board_watch_unavailable() : m.board_watch_checking()}
      </p>
    );
  return (
    <SignedInBoardWatchControl
      boardId={props.boardId}
      accountId={props.session.subject}
      csrfToken={props.session.csrfToken}
      authority={props.authority}
      {...(props.native === undefined ? {} : { native: props.native })}
    />
  );
}
