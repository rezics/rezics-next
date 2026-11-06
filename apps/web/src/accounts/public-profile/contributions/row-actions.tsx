import { useRouterState } from '@tanstack/react-router';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import type { ReactionKind } from '../../../threads/reaction-request';
import { contributionCommandTarget, originalContributionReference, type ContributionAdviceState } from '../contribution-actions/advice';
import { useContributionActionsHost, useContributionActionsPageScope } from '../contribution-actions/host';
import {
  ContributionAdvicePresentation,
  ContributionWatch,
  type ContributionPresentation,
} from '../contribution-actions/presentation';
import { ContributionReaction } from '../contribution-actions/reaction';
import { ContributionReport } from '../contribution-actions/report';
import { ContributionReply } from '../contribution-actions/reply';
import type { AuthorContributionActionsResponse } from '../contribution-actions/wire';

type Advice = AuthorContributionActionsResponse;
type Reference = { type: string; id: string };
type Section<T> = { notice: ContributionAdviceState } | { value: T };

const reactionKinds: readonly ReactionKind[] = ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'];
const reactionKind = (value: string): ReactionKind | undefined => reactionKinds.find((kind) => kind === value);

/** A response section that cannot prepare a control is shown as its own notice, never as a guessed control. */
const notice = (state: string): ContributionAdviceState =>
  state === 'sign_in_required' ? 'sign_in_required' : state === 'not_applicable' ? 'not_applicable' : 'unavailable';

/** A Post's watch belongs to its containing thread; the initial watching value must be known before a control shows. */
function watchSection(advice: Advice, threadId: string): Section<boolean> {
  if (advice.watch.state !== 'current') return { notice: notice(advice.watch.state) };
  const item = advice.watch.items.find((entry) => entry.threadId === threadId);
  if (!item) return { notice: 'missing' };
  if (item.state !== 'current') return { notice: notice(item.state) };
  return item.watching === undefined ? { notice: 'unavailable' } : { value: item.watching };
}

function reactionSection(
  advice: Advice,
  reference: Reference,
): Section<{ counts: Partial<Record<ReactionKind, number>>; value: ReactionKind | null }> {
  if (advice.reactions.state !== 'current') return { notice: notice(advice.reactions.state) };
  const item = advice.reactions.items.find((entry) => entry.type === reference.type && entry.id === reference.id);
  if (!item) return { notice: 'missing' };
  if (item.state !== 'current') return { notice: notice(item.state) };
  const selected = item.viewerSelection ?? null;
  const value = selected === null ? null : reactionKind(selected);
  if (value === undefined) return { notice: 'unavailable' };
  return { value: { counts: item.counts ?? {}, value } };
}

/** The reply state of this exact row; an absent or withdrawn selection cannot admit a reply. */
function replyState(advice: Advice, reference: Reference): ContributionPresentation['replyState'] {
  const entry = advice.selected.find(
    (selected) => selected.reference.type === reference.type && selected.reference.id === reference.id,
  );
  if (!entry) return 'unavailable';
  return entry.state === 'current' ? entry.reply.state : 'withheld';
}

/**
 * Native controls for one surviving Discussion, Review or Post row. Each control keeps its own exact advice and owner;
 * the host supplies the admitted visit and retained advice, and a row outside the admitted selection renders nothing.
 */
export function ContributionRowActions({
  item,
  locale,
  href,
}: {
  item: Record<string, unknown>;
  locale: Locale;
  href: string | undefined;
}) {
  const host = useContributionActionsHost();
  const scope = useContributionActionsPageScope();
  const returnTo = useRouterState({ select: (state) => state.location.href });
  if (!host?.input || !host.advice || !href) return null;
  const input = host.input;
  const advice = host.advice;
  const reference = originalContributionReference(input, item);
  if (!reference) return null;
  const presentation: ContributionPresentation = {
    input,
    row: item,
    source: advice,
    reader: host.reader,
    locale,
    isCurrent: host.isCurrent,
    operation: host.operation,
  };
  const options = { locale };
  const watch = watchSection(advice, contributionCommandTarget(reference, 'watch').id);
  const reactions = reactionSection(advice, reference);
  const verification = scope?.verification;
  return (
    <div role="group" aria-label={m.account_contribution_actions_label({}, options)} className="min-w-0 space-y-3">
      {'value' in watch ? (
        <ContributionWatch
          presentation={presentation}
          watching={watch.value}
          returnTo={returnTo}
          refreshAdvice={host.retry}
        />
      ) : (
        <ContributionAdvicePresentation state={watch.notice} label={m.thread_watch_watch({}, options)} locale={locale} />
      )}
      {'value' in reactions ? (
        <ContributionReaction
          presentation={presentation}
          counts={reactions.value.counts}
          value={reactions.value.value}
          returnTo={returnTo}
          refreshAdvice={host.retry}
          sourceWatermark={advice.reactions.reactionsAsOf}
        />
      ) : (
        <ContributionAdvicePresentation
          state={reactions.notice}
          label={m.reaction_reactions({}, options)}
          locale={locale}
        />
      )}
      {verification ? (
        <ContributionReport
          presentation={presentation}
          canonicalHref={href}
          verification={verification}
          refreshAdvice={host.retry}
        />
      ) : (
        <ContributionAdvicePresentation state="unavailable" label={m.report_action({}, options)} locale={locale} />
      )}
      <ContributionReply
        presentation={{ ...presentation, replyState: replyState(advice, reference) }}
        canonicalHref={href}
        refreshAdvice={host.retry}
      />
    </div>
  );
}
