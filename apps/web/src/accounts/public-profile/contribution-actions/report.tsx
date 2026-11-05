import { useEffect, useState } from 'react';
import { m } from '../../../paraglide/messages.js';
import type { VerificationConfig } from '../../../report/turnstile';
import { PostActions } from '../../../report/content-actions';
import type { OperationLease } from '../../../reader/lease';
import { contributionOperationLeaseId, type ContributionOperation } from './current';
import { contributionOperationAdvice, originalContributionReference, type ContributionAdviceState } from './advice';
import { ContributionAdvicePresentation, type ContributionPresentation } from './presentation';

function isReportLease(lease: OperationLease<ContributionOperation> | undefined): lease is OperationLease<'report'> {
  return lease?.operation === 'report';
}

/** Compose report advice with PostActions; that owner retains private report text and exact retry operands. */
export function ContributionReport({
  presentation,
  canonicalHref,
  verification,
  refreshAdvice,
}: {
  presentation: ContributionPresentation;
  /** The original native destination, used by PostActions for copy and report context. */
  canonicalHref: string;
  verification: VerificationConfig;
  refreshAdvice?: (() => Promise<void>) | undefined;
}) {
  const { input, row, source, reader, locale, isCurrent } = presentation;
  const reference = originalContributionReference(input, row);
  const advice: ContributionAdviceState = !isCurrent()
    ? 'retired'
    : presentation.failed
      ? 'failed'
      : reference
        ? contributionOperationAdvice({
            reference,
            operation: 'report',
            action: 'report:create',
            operationId: 'report.create',
            source,
            reader,
            isCurrent,
          })
        : 'unavailable';
  const candidateLease = isCurrent() ? presentation.operation('report') : undefined;
  const lease = isReportLease(candidateLease) ? candidateLease : undefined;
  const ready =
    advice === 'available' && !!reader && lease?.reader === reader && lease.current() && lease.credential() !== null;
  const state = advice === 'available' && !ready ? 'unavailable' : advice;
  const ownerKey = JSON.stringify([
    contributionOperationLeaseId(lease),
    input.accountId,
    input.view,
    input.cursor,
    input.proof,
    reference?.type,
    reference?.id,
    reference?.sourceRevisionId,
    row.id,
    row.revisionId,
  ]);

  return (
    <ContributionReportVisit
      key={ownerKey}
      presentation={presentation}
      state={state}
      reference={reference}
      lease={lease}
      ready={ready}
      canonicalHref={canonicalHref}
      verification={verification}
      refreshAdvice={refreshAdvice}
    />
  );
}

function ContributionReportVisit({
  presentation,
  state,
  reference,
  lease,
  ready,
  canonicalHref,
  verification,
  refreshAdvice,
}: {
  presentation: ContributionPresentation;
  state: ContributionAdviceState;
  reference: ReturnType<typeof originalContributionReference>;
  lease: OperationLease<'report'> | undefined;
  ready: boolean;
  canonicalHref: string;
  verification: VerificationConfig;
  refreshAdvice?: (() => Promise<void>) | undefined;
}) {
  const [admitted, setAdmitted] = useState(ready);
  useEffect(() => {
    if (ready) setAdmitted(true);
  }, [ready]);

  const retaining = (ready || admitted) && presentation.isCurrent() && !!lease && lease.current();
  const target = reference
    ? { kind: reference.type === 'content.thread' ? ('thread' as const) : ('post' as const), id: reference.id }
    : undefined;

  return (
    <ContributionAdvicePresentation
      state={state}
      label={m.report_action({}, { locale: presentation.locale })}
      locale={presentation.locale}
      retry={refreshAdvice}
      retainChildren={retaining && state !== 'available'}
    >
      {retaining && target && lease ? (
        <PostActions
          target={target}
          {...(reference?.sourceRevisionId ? { revisionId: reference.sourceRevisionId } : {})}
          canonicalHref={canonicalHref}
          verification={verification}
          commandLease={lease}
          canStartReport={state === 'available' && ready}
        />
      ) : null}
    </ContributionAdvicePresentation>
  );
}
