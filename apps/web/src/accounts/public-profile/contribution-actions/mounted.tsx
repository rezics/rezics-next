import { useRef } from 'react';
import type { Locale } from '../../../paraglide/runtime.js';
import type { ReactionKind } from '@rezics/ui/reactions';
import { useContributionActionsHost } from './host';
import { originalContributionReference } from './advice';
import { ContributionWatch, type ContributionPresentation } from './presentation';
import { ContributionReaction } from './reaction';
import { ContributionReport } from './report';
import { ContributionReply } from './reply';
import type { ContributionActionsRead } from './installed';
import { contributionOperationLeaseId } from './current';

function reactionKind(value: string | null | undefined): ReactionKind | null | undefined {
  switch (value) {
    case null: case 'upvote': case 'downvote': case 'like': case 'love': case 'laugh': case 'insightful': case 'sad': return value;
    default: return undefined;
  }
}

/** The only installed row adapter. Public row identities can select, never create, native advice. */
export function MountedContributionActions({ row, locale, canonicalHref }: {
  row: Record<string, unknown>;
  locale: Locale;
  canonicalHref: string;
}) {
  const host = useContributionActionsHost();
  const retained = useRef<{ input: string; read: ContributionActionsRead } | undefined>(undefined);
  const watchBaseline = useRef<ContributionActionsRead['response']['watch']['items'][number] | undefined>(undefined);
  const reactionBaseline = useRef<ContributionActionsRead['response']['reactions']['items'][number] | undefined>(undefined);
  if (!host?.input || !host.isCurrent()) {
    retained.current = undefined;
    watchBaseline.current = undefined;
    reactionBaseline.current = undefined;
    return null;
  }
  const reference = originalContributionReference(host.input, row);
  if (!reference) return null;
  const response = host.state.state === 'ready' ? host.state.value.response : undefined;
  const viewerMatches = response?.viewer.kind === 'account' && response.viewer.id === host.reader;
  if (host.state.state === 'ready' && viewerMatches) retained.current = { input: host.input.proof, read: host.state.value };
  // A refresh must retain command owners but lends no earlier advice to new commands.
  const read = retained.current?.input === host.input.proof ? retained.current.read : undefined;
  if (!read) return null;
  const selected = response?.selected.find((item) => item.reference.type === reference.type && item.reference.id === reference.id);
  const current = viewerMatches && selected?.state === 'current';
  const presentation: ContributionPresentation = {
    input: host.input, row, locale, reader: host.reader,
    source: current ? response : undefined,
    replyState: current ? selected.reply.state : 'unavailable',
    failed: host.state.state === 'failed',
    isCurrent: host.isCurrent, operation: host.operation,
  };
  const baseline = read.response;
  const threadId = reference.type === 'content.post' ? reference.threadId : reference.id;
  const watch = baseline.watch.items.find((item) => item.threadId === threadId);
  const reaction = baseline.reactions.items.find((item) => item.type === reference.type && item.id === reference.id);
  const watchCurrent = baseline.currentness.watch === 'current' && baseline.watch.state === 'current' && watch?.state === 'current' && typeof watch.watching === 'boolean';
  const reactionCurrent = baseline.currentness.reactions === 'current' && baseline.reactions.state === 'current' && reaction?.state === 'current' && !!reaction.counts && reactionKind(reaction.viewerSelection) !== undefined;
  if (watchCurrent) watchBaseline.current = watch;
  if (reactionCurrent) reactionBaseline.current = reaction;
  const watching = watchBaseline.current?.watching;
  const reactionSlot = reactionBaseline.current;
  const watchPresentation = watchCurrent ? presentation : { ...presentation, source: undefined };
  const reactionPresentation = reactionCurrent ? presentation : { ...presentation, source: undefined };
  const returnTo = window.location.pathname + window.location.search + window.location.hash;
  return (
    <div data-slot="mounted-contribution-actions" className="min-w-0 space-y-3">
      {typeof watching === 'boolean' ? <ContributionWatch key={`watch:${contributionOperationLeaseId(host.operation('watch'))}`} presentation={watchPresentation} watching={watching} returnTo={returnTo} refreshAdvice={host.retry} /> : null}
      {reactionSlot?.counts ? <ContributionReaction key={`reaction:${contributionOperationLeaseId(host.operation('reaction'))}`} presentation={reactionPresentation} counts={reactionSlot.counts} value={reactionKind(reactionSlot.viewerSelection)!} returnTo={returnTo} sourceWatermark={baseline.reactions.reactionsAsOf} refreshAdvice={host.retry} /> : null}
      <ContributionReport presentation={presentation} canonicalHref={canonicalHref} verification={read.verification} refreshAdvice={host.retry} />
      <ContributionReply presentation={presentation} canonicalHref={canonicalHref} refreshAdvice={host.retry} />
    </div>
  );
}
