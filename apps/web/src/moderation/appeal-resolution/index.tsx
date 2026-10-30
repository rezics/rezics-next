import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Textarea } from '@rezics/ui/shadcn/textarea';
import { m } from '../../paraglide/messages.js';
import { csrfHeaders } from '../../threads/composer';
import { actionOnAppeal, type AppealResolutionResult } from '../actions';
import { createModerationIntent } from '../command-intent';

export type ResolutionCommand = {
  id: string;
  outcome: 'uphold' | 'reverse';
  statement: string;
  idempotencyKey: string;
};
export type ResolveAppeal = (input: ResolutionCommand) => Promise<AppealResolutionResult>;
type Resolution = { outcome: 'upheld' | 'reversed'; statement: string };

const resolveAppeal: ResolveAppeal = (data) => actionOnAppeal({ data, headers: csrfHeaders() });

/** Shared by the queue page and its interactive pattern stories. Success stays visible until navigation. */
export function AppealResolution({
  appealId,
  mayResolve,
  resolution,
  onResolve = resolveAppeal,
}: {
  appealId: string;
  mayResolve: boolean;
  resolution?: Resolution | null;
  onResolve?: ResolveAppeal;
}) {
  const [statement, setStatement] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [terminal, setTerminal] = useState(false);
  const [confirmed, setConfirmed] = useState<Resolution | null>(null);
  const [commandIntent] = useState(createModerationIntent);
  const result = confirmed ?? resolution;
  const count = Array.from(statement.trim()).length;

  async function resolve(outcome: 'uphold' | 'reverse') {
    if (count < 1 || count > 2000 || pending || terminal || !mayResolve || result) return;
    const intent = { id: appealId, outcome, statement: statement.trim() };
    setPending(true);
    setMessage('');
    try {
      const response = await onResolve({ ...intent, idempotencyKey: commandIntent.keyFor(intent) });
      if (response.state === 'forbidden') {
        setTerminal(true);
        setMessage(m.moderation_appeal_other_moderator());
      } else if (response.state === 'conflict') {
        setTerminal(true);
        setMessage(m.moderation_appeal_conflict());
      } else {
        setConfirmed({
          outcome: response.outcome === 'uphold' ? 'upheld' : 'reversed',
          statement: response.statement,
        });
      }
    } catch {
      setMessage(m.moderation_appeal_action_failed());
    } finally {
      setPending(false);
    }
  }

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
              disabled={pending || terminal || !mayResolve}
              aria-invalid={count > 2000}
              onChange={(event) => {
                commandIntent.changed();
                setStatement(event.target.value);
              }}
            />
          </label>
          <p className="text-sm text-muted-foreground">{m.decision_appeal_count({ count })}</p>
          {mayResolve && !terminal ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={pending || count < 1 || count > 2000}
                onClick={() => void resolve('uphold')}
              >
                {m.moderation_appeal_uphold_action()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending || count < 1 || count > 2000}
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
    </div>
  );
}
