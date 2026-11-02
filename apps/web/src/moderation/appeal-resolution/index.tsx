import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../../paraglide/messages.js';
import { csrfHeaders } from '../../threads/composer';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
import { useSession } from '../../session/query';
import { actionOnAppeal, type AppealResolutionResult } from '../actions';
import { appealNavigationContext } from '../appeals-read-model';
import { createAppealResolutionIntent, type ResolutionCommand } from './intent';

export type { ResolutionCommand } from './intent';
export type ResolveAppeal = (input: ResolutionCommand) => Promise<AppealResolutionResult>;
type Resolution = { outcome: 'upheld' | 'reversed'; statement: string };

const resolveAppeal: ResolveAppeal = (data) => actionOnAppeal({ data, headers: csrfHeaders() });

/**
 * One mounted form owns its private statement and intent. Submission freezes the trimmed payload and UUID synchronously.
 * A lost response permits only explicit exact retry; definitive refusals require a fresh authorized page read.
 * Viewer/session, appeal or admission retirement discards private presentation and fences late settlement.
 * Confirmation survives unrelated parent refreshes; this form never refreshes or automatically resumes a command.
 * The queue waits for pending or uncertain intent to settle before refreshing its native generation.
 * Unknown-session injected fixtures remain usable without granting the default action browser admission.
 */
type AppealResolutionProps = {
  appealId: string;
  mayResolve: boolean;
  resolution?: Resolution | null;
  onResolve?: ResolveAppeal;
  isCurrent?: () => boolean;
  onUnresolvedChange?: (unresolved: boolean) => void;
};

export function AppealResolution(props: AppealResolutionProps) {
  return (
    <AuthoringDepartureBoundary sessionBound={false}>
      <ResolutionForm {...props} />
    </AuthoringDepartureBoundary>
  );
}

function ResolutionForm({
  appealId,
  mayResolve,
  resolution,
  onResolve = resolveAppeal,
  isCurrent,
  onUnresolvedChange,
}: AppealResolutionProps) {
  const [intent] = useState(() => createAppealResolutionIntent(appealId));
  const [, redraw] = useReducer((version: number) => version + 1, 0);
  const mounted = useRef(true);
  const session = useSession();
  const viewer =
    session.state === 'unknown' ? null : JSON.stringify([session.state, session.subject, session.csrfToken]);
  const admitted =
    mayResolve &&
    ((session.state === 'signed-in' && Boolean(session.subject) && Boolean(session.csrfToken)) ||
      (session.state === 'unknown' && onResolve !== resolveAppeal));
  const focusAttempt = useRef(0);
  const keyboardActivation = useRef<HTMLElement | null>(null);
  const resultFocusTarget = useRef<HTMLParagraphElement | null>(null);
  const pendingFocus = useRef<{
    attempt: number;
    command: NonNullable<typeof intent.command>;
    source: HTMLElement;
    appealId: string;
    viewer: string | null;
    cleanup: () => void;
  } | null>(null);
  const focusScope = useRef({ appealId, viewer, admitted });

  function cancelFocusHandoff() {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    pending?.cleanup();
  }

  function startFocusHandoff(attempt: number, command: NonNullable<typeof intent.command>, source: HTMLElement) {
    const cancel = () => cancelFocusHandoff();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') cancel();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target !== source && event.target !== document.body) cancel();
    };
    const cleanup = () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
    pendingFocus.current = { attempt, command, source, appealId, viewer, cleanup };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
  }

  if (
    focusScope.current.appealId !== appealId ||
    focusScope.current.viewer !== viewer ||
    focusScope.current.admitted !== admitted
  ) {
    keyboardActivation.current = null;
    cancelFocusHandoff();
    focusScope.current = { appealId, viewer, admitted };
  }
  intent.synchronize(appealId, viewer, admitted);
  // The page owner connects after the first empty render. Private state requires its current admission;
  // callbacks below also check it before accepting the first input or command.
  if ((intent.statement !== '' || intent.phase !== 'draft') && isCurrent?.() === false) {
    keyboardActivation.current = null;
    cancelFocusHandoff();
    intent.retire();
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      keyboardActivation.current = null;
      cancelFocusHandoff();
      // StrictMode can reconnect this owner synchronously; a final unmount discards its private memory.
      queueMicrotask(() => {
        if (!mounted.current) intent.retire();
      });
    };
  }, [intent]);
  const statement = intent.statement;
  const pending = intent.phase === 'pending';
  const uncertain = intent.phase === 'uncertain';
  const terminal = intent.phase === 'settled';
  const response = intent.result;
  const result: Resolution | null | undefined =
    response?.state === 'resolved'
      ? { outcome: response.outcome === 'uphold' ? 'upheld' : 'reversed', statement: response.statement }
      : resolution;
  const count = Array.from(statement.trim()).length;
  const departure = useAuthoringDeparture(
    () => mounted.current && isCurrent?.() !== false && !result && intent.needsDecision,
    () => intent.unresolved,
    JSON.stringify([appealId, statement, intent.phase]),
    undefined,
    () => {
      intent.retire();
      redraw();
    },
    undefined,
    {
      title: m.moderation_resolution_leave_title(),
      unsaved: m.moderation_resolution_leave_unsaved(),
      pending: m.moderation_resolution_leave_pending(),
    },
    appealNavigationContext,
  );
  const message = uncertain
    ? m.moderation_appeal_intent_uncertain()
    : response?.state === 'forbidden'
      ? `${m.moderation_appeal_other_moderator()} ${m.moderation_appeal_intent_forbidden_recovery()}`
      : response?.state === 'conflict'
        ? `${m.moderation_appeal_conflict()} ${m.moderation_appeal_intent_conflict_recovery()}`
        : '';

  useLayoutEffect(() => {
    const handoff = pendingFocus.current;
    if (!handoff || response?.state !== 'resolved' || intent.phase !== 'settled') return;
    if (
      handoff.attempt !== focusAttempt.current ||
      handoff.command !== intent.command ||
      handoff.appealId !== appealId ||
      handoff.viewer !== viewer ||
      !admitted ||
      !current()
    ) {
      cancelFocusHandoff();
      return;
    }
    cancelFocusHandoff();
    resultFocusTarget.current?.focus();
  }, [admitted, appealId, intent, intent.phase, response, viewer]);

  function current() {
    if (!mounted.current) return false;
    // A page can retire between render and an input, submit or transport callback.
    if (isCurrent?.() === false) {
      keyboardActivation.current = null;
      cancelFocusHandoff();
      if (intent.retire()) redraw();
      return false;
    }
    if (intent.phase === 'retired') cancelFocusHandoff();
    return intent.phase !== 'retired';
  }

  async function resolve(outcome?: ResolutionCommand['outcome'], keyboardTarget?: HTMLElement | null) {
    keyboardActivation.current = null;
    cancelFocusHandoff();
    if (!current() || !admitted || result) return;
    const attempt = ++focusAttempt.current;
    const command = outcome === undefined ? intent.retry() : intent.begin(outcome);
    if (!command) return;
    if (keyboardTarget) startFocusHandoff(attempt, command, keyboardTarget);
    // Notify synchronously: a second click must not unmount this command before React renders.
    onUnresolvedChange?.(intent.unresolved);
    redraw();
    try {
      if (!current()) return;
      const response = await onResolve(command);
      if (current()) {
        intent.settle(response);
        // A validated receipt acknowledges this frozen statement without waiting for any parent read.
        if (response.state === 'resolved') departure.release();
        else cancelFocusHandoff();
      }
    } catch {
      if (current()) {
        intent.uncertain();
        cancelFocusHandoff();
      }
    } finally {
      if (current()) {
        onUnresolvedChange?.(intent.unresolved);
        redraw();
      }
    }
  }

  if (intent.phase === 'retired') return <p role="alert">{m.moderation_appeal_intent_retired()}</p>;

  if (result)
    return (
      <p ref={resultFocusTarget} role="status" tabIndex={-1} className="font-medium">
        {result.outcome === 'upheld' ? m.moderation_appeal_upheld() : m.moderation_appeal_reversed()}
        <span className="block whitespace-pre-wrap font-normal">{result.statement}</span>
      </p>
    );

  return (
    <div
      className="space-y-3"
      onKeyDownCapture={(event) => {
        if (event.key === 'Tab') {
          keyboardActivation.current = null;
          cancelFocusHandoff();
        } else if (
          (event.key === 'Enter' || event.key === ' ') &&
          event.target instanceof HTMLElement &&
          event.target.hasAttribute('data-resolution-action')
        ) {
          keyboardActivation.current = event.target;
        }
      }}
      onBlurCapture={(event) => {
        if (event.target === keyboardActivation.current) keyboardActivation.current = null;
      }}
      onPointerDownCapture={() => {
        keyboardActivation.current = null;
        cancelFocusHandoff();
      }}
    >
      {mayResolve || statement ? (
        <form className="space-y-3" aria-busy={pending} onSubmit={(event) => event.preventDefault()}>
          <label className="block space-y-1">
            <span>{m.moderation_statement_label()}</span>
            <Textarea
              name="statement"
              required
              rows={4}
              value={statement}
              disabled={pending || uncertain || terminal || !admitted}
              aria-invalid={count > 2000}
              onChange={(event) => {
                if (current() && admitted && intent.edit(event.target.value)) redraw();
              }}
            />
          </label>
          <p className="text-sm text-muted-foreground">{m.decision_appeal_count({ count })}</p>
          {mayResolve && !terminal ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!admitted || pending || uncertain || count < 1 || count > 2000}
                data-resolution-action="uphold"
                onClick={(event) =>
                  void resolve(
                    'uphold',
                    event.detail === 0 && keyboardActivation.current === event.currentTarget
                      ? event.currentTarget
                      : null,
                  )
                }
              >
                {m.moderation_appeal_uphold_action()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!admitted || pending || uncertain || count < 1 || count > 2000}
                data-resolution-action="reverse"
                onClick={(event) =>
                  void resolve(
                    'reverse',
                    event.detail === 0 && keyboardActivation.current === event.currentTarget
                      ? event.currentTarget
                      : null,
                  )
                }
              >
                {m.moderation_appeal_reverse_action()}
              </Button>
            </div>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{m.moderation_appeal_other_moderator()}</p>
      )}
      {message ? <p role="alert">{message}</p> : null}
      {uncertain ? (
        <Button
          type="button"
          variant="outline"
          disabled={!admitted}
          data-resolution-action="retry"
          onClick={(event) =>
            void resolve(
              undefined,
              event.detail === 0 && keyboardActivation.current === event.currentTarget ? event.currentTarget : null,
            )
          }
        >
          {m.moderation_appeal_intent_retry()}
        </Button>
      ) : null}
    </div>
  );
}
