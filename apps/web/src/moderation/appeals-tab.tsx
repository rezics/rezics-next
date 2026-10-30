import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { AppealResolution } from './appeal-resolution';
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
  const identity = appealTarget(appeal);

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
      <AppealResolution appealId={appeal.id} mayResolve={mayResolve} resolution={appeal.decision.appeal} />
    </li>
  );
}
