import { useState } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { actionOnAppeal } from './actions';
import type { Appeal } from './appeals-read';
import { moderationTargetContent, type ModerationTarget } from './reports-page';

export function ModerationAppealsView({
  appeals,
  targets,
  next,
  threadId,
  onNext,
  viewerId,
  canResolve,
}: {
  appeals: Appeal[];
  targets: ModerationTarget[];
  next: string | null;
  threadId?: string;
  onNext?: (cursor: string) => void;
  viewerId?: string;
  canResolve?: (appeal: Appeal) => boolean;
}) {
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">{m.moderation_appeals_tab()}</p>
        <PageHeading>{m.moderation_appeals_heading()}</PageHeading>
      </header>
      <nav aria-label={m.moderation_tabs_label()} className="flex gap-4 border-b pb-2">
        <a href={threadId ? `?thread=${encodeURIComponent(threadId)}` : '?'}>{m.moderation_reports_tab()}</a>
        <span aria-current="page" className="font-semibold">
          {m.moderation_appeals_tab()}
        </span>
      </nav>
      {threadId ? <p className="text-sm text-muted-foreground">{m.moderation_thread_filter()}</p> : null}
      {appeals.length ? (
        <ol className="space-y-4">
          {appeals.map((appeal) => {
            const targetIdentity =
              appeal.decision.target ??
              (appeal.decision.targetKind && appeal.decision.targetId
                ? { kind: appeal.decision.targetKind, id: appeal.decision.targetId }
                : undefined);
            const target = targets.find((item) => item.key === `${targetIdentity?.kind}:${targetIdentity?.id}`);
            const mayResolve =
              appeal.canResolve !== false &&
              (!viewerId || viewerId !== appeal.decision.deciderId) &&
              (canResolve?.(appeal) ?? true);
            return <AppealCard key={appeal.id} appeal={appeal} target={target} mayResolve={mayResolve} />;
          })}
        </ol>
      ) : (
        <p className="text-muted-foreground">{m.moderation_appeals_empty()}</p>
      )}
      {next ? (
        <button type="button" className="rounded-md border px-4 py-2" onClick={() => onNext?.(next)}>
          {m.threads_next_page()}
        </button>
      ) : null}
    </article>
  );
}

function AppealCard({
  appeal,
  target,
  mayResolve,
}: {
  appeal: Appeal;
  target: ModerationTarget | undefined;
  mayResolve: boolean;
}) {
  const [resolution, setResolution] = useState(appeal.decision.appeal ?? null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [cannotResolve, setCannotResolve] = useState(false);

  async function resolve(form: HTMLFormElement, outcome: 'uphold' | 'reverse') {
    const data = new FormData(form);
    const statement = String(data.get('statement') ?? '').trim();
    if (!statement) return;
    setPending(true);
    setMessage('');
    try {
      const result = await actionOnAppeal({ data: { id: appeal.id, outcome, statement } });
      if (result.state === 'forbidden') {
        setCannotResolve(true);
        setMessage(m.moderation_appeal_other_moderator());
        return;
      }
      setResolution({
        outcome: result.outcome === 'uphold' ? 'upheld' : 'reversed',
        statement: result.statement,
        resolvedAt: new Date().toISOString(),
      });
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined;
      if (status === 403) {
        setCannotResolve(true);
        setMessage(m.moderation_appeal_other_moderator());
      } else {
        setMessage(m.moderation_appeal_action_failed());
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <section className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {m.moderation_appeal_decision_label()}: {appeal.decision.statement}
        </p>
        <blockquote className="border-l-2 pl-3">{moderationTargetContent(target)}</blockquote>
      </section>
      <p>
        <span className="font-medium">{m.moderation_appeal_reason_label()}:</span> {appeal.statement}
      </p>
      {resolution ? (
        <p role="status" className="font-medium">
          {resolution.outcome === 'upheld' ? m.moderation_appeal_upheld() : m.moderation_appeal_reversed()}
          <span className="block font-normal">{resolution.statement}</span>
        </p>
      ) : mayResolve && !cannotResolve ? (
        <form className="space-y-3" onSubmit={(event) => event.preventDefault()}>
          <label className="block space-y-1">
            <span>{m.moderation_statement_label()}</span>
            <textarea
              name="statement"
              required
              maxLength={2000}
              className="min-h-20 w-full rounded-md border bg-background p-2"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (form) void resolve(form, 'uphold');
              }}
            >
              {m.moderation_appeal_uphold_action()}
            </button>
            <button
              type="button"
              disabled={pending}
              className="rounded-md border px-4 py-2"
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (form) void resolve(form, 'reverse');
              }}
            >
              {m.moderation_appeal_reverse_action()}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{m.moderation_appeal_other_moderator()}</p>
      )}
      {message ? <p role="alert">{message}</p> : null}
    </li>
  );
}
