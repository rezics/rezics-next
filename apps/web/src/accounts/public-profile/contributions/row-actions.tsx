import { useState } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import type { VerificationConfig } from '../../../features/pages/account-profile-port';
import {
  contributionCommandTarget,
  type ContributionAdviceState,
  originalContributionReference,
} from '../contribution-actions/advice';
import { useContributionActionsHost, useContributionActionsPageScope } from '../contribution-actions/host';
import {
  ContributionAdvicePresentation,
  ContributionWatch,
  type ContributionPresentation,
} from '../contribution-actions/presentation';
import { ContributionReaction } from '../contribution-actions/reaction';
import { ContributionReport } from '../contribution-actions/report';
import { ContributionReply } from '../contribution-actions/reply';
import type { AuthorContributionActionsResponse, ContributionReference } from '../contribution-actions/wire';
import {
  contributionSelectedState,
  contributionWatchSection,
  contributionReactionSection,
} from '../contribution-actions/adapter';
type Advice = AuthorContributionActionsResponse;
type Section<T> = { notice: ContributionAdviceState } | { value: T };

/**
 * One adapter per surviving public occurrence. The anonymous selection supplies native references, while
 * the host supplies private advice and original operation leases. The native controls own every write.
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
  if (!host?.input || !host.advice || !href) return null;
  const reference = originalContributionReference(host.input, item);
  if (!reference) return null;
  const selected = contributionSelectedState(host.advice, reference);
  const restriction =
    host.state.state === 'failed' ? 'failed' : host.state.state !== 'ready' ? 'unavailable' : selected;
  const presentation: ContributionPresentation = {
    input: host.input,
    row: item,
    source: host.advice,
    reader: host.reader,
    locale,
    isCurrent: host.isCurrent,
    operation: host.operation,
    ...(restriction !== 'available' ? { restriction } : {}),
  };
  return (
    <ContributionRowActionOwners
      presentation={presentation}
      advice={host.advice}
      reference={reference}
      href={href}
      verification={scope?.verification}
      refreshAdvice={host.retry}
    />
  );
}

function ContributionRowActionOwners({
  presentation,
  advice,
  reference,
  href,
  verification,
  refreshAdvice,
}: {
  presentation: ContributionPresentation;
  advice: Advice;
  reference: ContributionReference;
  href: string;
  verification: VerificationConfig | undefined;
  refreshAdvice: () => Promise<void>;
}) {
  const returnTo = useRouterState({ select: (state) => state.location.href });
  const watch = contributionWatchSection(advice, contributionCommandTarget(reference, 'watch').id);
  const reactions = contributionReactionSection(advice, reference);
  // Retain only this occurrence's last admitted projection. A withheld refresh disables new commands,
  // but cannot unmount the owner retaining the original uncertain request and credential.
  const [lastWatch, setLastWatch] = useState('value' in watch ? watch.value : undefined);
  const [lastReaction, setLastReaction] = useState('value' in reactions ? reactions.value : undefined);
  if ('value' in watch && lastWatch !== watch.value) setLastWatch(watch.value);
  if (
    'value' in reactions &&
    (lastReaction?.counts !== reactions.value.counts ||
      lastReaction?.value !== reactions.value.value ||
      lastReaction?.watermark !== reactions.value.watermark)
  )
    setLastReaction(reactions.value);
  const selected = advice.selected.find(
    (entry) => entry.reference.type === reference.type && entry.reference.id === reference.id,
  );
  const replyState = selected?.state === 'current' ? selected.reply.state : 'withheld';
  const restrict = (section: Section<unknown>): ContributionPresentation => ({
    ...presentation,
    ...('notice' in section && !presentation.restriction ? { restriction: section.notice } : {}),
  });
  const sourceWatermark = 'value' in reactions ? reactions.value.watermark : lastReaction?.watermark;
  return (
    <div
      role="group"
      aria-label={m.account_contribution_actions_label({}, { locale: presentation.locale })}
      className="min-w-0 space-y-3"
    >
      <ContributionWatch
        presentation={restrict(watch)}
        watching={'value' in watch ? watch.value : (lastWatch ?? false)}
        returnTo={returnTo}
        refreshAdvice={refreshAdvice}
      />
      <ContributionReaction
        presentation={restrict(reactions)}
        counts={'value' in reactions ? reactions.value.counts : (lastReaction?.counts ?? {})}
        value={'value' in reactions ? reactions.value.value : (lastReaction?.value ?? null)}
        returnTo={returnTo}
        refreshAdvice={refreshAdvice}
        {...(sourceWatermark ? { sourceWatermark } : {})}
      />
      {verification ? (
        <ContributionReport
          presentation={presentation}
          canonicalHref={href}
          verification={verification}
          refreshAdvice={refreshAdvice}
        />
      ) : (
        <ContributionAdvicePresentation
          state="unavailable"
          label={m.report_action({}, { locale: presentation.locale })}
          locale={presentation.locale}
        />
      )}
      <ContributionReply
        presentation={{ ...presentation, replyState }}
        canonicalHref={href}
        refreshAdvice={refreshAdvice}
      />
    </div>
  );
}
