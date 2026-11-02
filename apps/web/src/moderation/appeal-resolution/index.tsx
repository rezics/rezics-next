import { useEffect, useReducer, useRef, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../../paraglide/messages.js';
import { csrfHeaders } from '../../threads/composer';
import { useSession } from '../../session/query';
import { actionOnAppeal, type AppealResolutionResult } from '../actions';
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
export function AppealResolution({
  appealId,
  mayResolve,
  resolution,
  onResolve = resolveAppeal,
  isCurrent,
  onUnresolvedChange,
}: {
  appealId: string;
  mayResolve: boolean;
  resolution?: Resolution | null;
  onResolve?: ResolveAppeal;
  isCurrent?: () => boolean;
  onUnresolvedChange?: (unresolved: boolean) => void;
}) {
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
  intent.synchronize(appealId, viewer, admitted);
  // The page owner connects after the first empty render. Private state requires its current admission;
  // callbacks below also check it before accepting the first input or command.
  if ((intent.statement !== '' || intent.phase !== 'draft') && isCurrent?.() === false) intent.retire();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
  const message = uncertain
    ? m.moderation_appeal_intent_uncertain()
    : response?.state === 'forbidden'
      ? `${m.moderation_appeal_other_moderator()} ${m.moderation_appeal_intent_forbidden_recovery()}`
      : response?.state === 'conflict'
        ? `${m.moderation_appeal_conflict()} ${m.moderation_appeal_intent_conflict_recovery()}`
        : '';

  function current() {
    if (!mounted.current) return false;
    // A page can retire between render and an input, submit or transport callback.
    if (isCurrent?.() === false) {
      if (intent.retire()) redraw();
      return false;
    }
    return intent.phase !== 'retired';
  }

  async function resolve(outcome?: ResolutionCommand['outcome']) {
    if (!current() || !admitted || result) return;
    const command = outcome === undefined ? intent.retry() : intent.begin(outcome);
    if (!command) return;
    // Notify synchronously: a second click must not unmount this command before React renders.
    onUnresolvedChange?.(intent.unresolved);
    redraw();
    try {
      if (!current()) return;
      const response = await onResolve(command);
      if (current()) intent.settle(response);
    } catch {
      if (current()) intent.uncertain();
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
      <p role="status" className="font-medium">
        {result.outcome === 'upheld' ? m.moderation_appeal_upheld() : m.moderation_appeal_reversed()}
        <span className="block whitespace-pre-wrap font-normal">{result.statement}</span>
      </p>
    );

  return (
    <div className="space-y-3">
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
                onClick={() => void resolve('uphold')}
              >
                {m.moderation_appeal_uphold_action()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!admitted || pending || uncertain || count < 1 || count > 2000}
                onClick={() => void resolve('reverse')}
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
        <Button type="button" variant="outline" disabled={!admitted} onClick={() => void resolve()}>
          {m.moderation_appeal_intent_retry()}
        </Button>
      ) : null}
    </div>
  );
}
