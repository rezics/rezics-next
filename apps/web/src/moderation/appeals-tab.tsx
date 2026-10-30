import { useState } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { actionOnAppeal } from './actions';
import { appealTarget, type Appeal } from './appeals-read';
import { moderationTargetContent, type ModerationTarget } from './reports-page';

export function ModerationAppealsView({
  appeals,
  targets,
  next,
  threadId,
  postId,
  onNext,
  viewerId,
  canResolve,
}: {
  appeals: Appeal[];
  targets: ModerationTarget[];
  next: string | null;
  threadId?: string;
  postId?: string;
  onNext?: (cursor: string) => void;
  viewerId?: string;
  canResolve?: (appeal: Appeal) => boolean;
}) {
  const filters = [
    threadId ? `thread=${encodeURIComponent(threadId)}` : '',
    postId ? `post=${encodeURIComponent(postId)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const reportsHref = filters ? `?${filters}` : '?';
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">{m.moderation_appeals_tab()}</p>
        <PageHeading>{m.moderation_appeals_heading()}</PageHeading>
      </header>
      <nav aria-label={m.moderation_tabs_label()} className="flex gap-4 border-b pb-2">
        <a href={reportsHref}>{m.moderation_reports_tab()}</a>
        <span aria-current="page" className="font-semibold">
          {m.moderation_appeals_tab()}
        </span>
      </nav>
      {threadId ? <p className="text-sm text-muted-foreground">{m.moderation_thread_filter()}</p> : null}
      {appeals.length ? (
        <ol className="space-y-4">
          {appeals.map((appeal) => {
            const identity = appealTarget(appeal);
            const target = targets.find((item) => item.key === `${identity?.kind}:${identity?.id}`);
            const mayResolve =
              (appeal.canResolve === true || (appeal.canResolve === undefined && canResolve?.(appeal) === true)) &&
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
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const identity = appealTarget(appeal);
  const resolution = appeal.decision.appeal;

  async function resolve(form: HTMLFormElement, outcome: 'uphold' | 'reverse') {
    const statement = String(new FormData(form).get('statement') ?? '').trim();
    if (!statement || pending || conflicted || forbidden || !mayResolve || resolution) return;
    setPending(true);
    setMessage('');
    try {
      const result = await actionOnAppeal({ data: { id: appeal.id, outcome, statement }, headers: csrfHeaders() });
      if (result.state === 'forbidden') {
        setForbidden(true);
        setMessage(m.moderation_appeal_other_moderator());
        setPending(false);
        return;
      }
      if (result.state === 'conflict') {
        setMessage(m.moderation_appeal_conflict());
        setConflicted(true);
        setPending(false);
        return;
      }
      // The queue is the authoritative receipt; show its newly committed outcome after reload.
      location.reload();
    } catch {
      setMessage(m.moderation_appeal_action_failed());
      setPending(false);
    }
  }

  return (
    <li className="space-y-3 rounded-lg border p-4">
      <section className="space-y-2">
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">
          <span className="font-medium">{m.moderation_appeal_decision_label()}:</span> {appeal.decision.statement}
        </p>
        {identity ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium">{m.moderation_appeal_target_label()}:</span> {identity.kind}{' '}
            <code>{identity.id}</code>
          </p>
        ) : null}
        <blockquote className="border-l-2 pl-3">{moderationTargetContent(target)}</blockquote>
      </section>
      <p className="whitespace-pre-wrap">
        <span className="font-medium">{m.moderation_appeal_reason_label()}:</span> {appeal.statement}
      </p>
      {resolution ? (
        <p role="status" className="font-medium">
          {resolution.outcome === 'upheld' ? m.moderation_appeal_upheld() : m.moderation_appeal_reversed()}
          <span className="block font-normal">{resolution.statement}</span>
        </p>
      ) : mayResolve && !forbidden ? (
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
              disabled={pending || conflicted}
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
              disabled={pending || conflicted}
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
