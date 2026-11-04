import type { ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { ThreadWatch, type ThreadWatchProps } from '../../../threads/thread-watch';
import type { OperationLease } from '../../../reader/lease';
import type { ContributionOperation } from './current';
import type { ContributionActionsInput } from './receiver';
import {
  contributionCommandTarget,
  contributionOperationAdvice,
  originalContributionReference,
  type ContributionAdviceState,
  type NativeContributionAdvice,
} from './advice';

/** Prepared native presentation input, never an adapter for the receiver's unknown response. */
export type ContributionPresentation = {
  input: ContributionActionsInput;
  row: Record<string, unknown>;
  source: NativeContributionAdvice | undefined;
  reader: string | null;
  locale: Locale;
  isCurrent(): boolean;
  operation(name: ContributionOperation): OperationLease<ContributionOperation> | undefined;
  failed?: boolean;
};

function adviceText(state: Exclude<ContributionAdviceState, 'available'>, locale: Locale) {
  const options = { locale };
  switch (state) {
    case 'denied':
      return m.profile_contribution_action_denied({}, options);
    case 'missing':
      return m.profile_contribution_action_missing({}, options);
    case 'withheld':
      return m.profile_contribution_action_withheld({}, options);
    case 'not_applicable':
      return m.profile_contribution_action_not_applicable({}, options);
    case 'failed':
      return m.profile_contribution_action_failed({}, options);
    case 'sign_in_required':
      return m.profile_contribution_actions_sign_in({}, options);
    case 'retired':
      return m.profile_contribution_actions_retired({}, options);
    case 'unavailable':
      return m.profile_contribution_actions_unavailable({}, options);
  }
}

/** Current denial is a successful advice result. A retry only reacquires advice, never sends a command. */
export function ContributionAdvicePresentation({
  state,
  label,
  locale,
  retry,
  children,
}: {
  state: ContributionAdviceState;
  label: string;
  locale: Locale;
  retry?: (() => Promise<void>) | undefined;
  children?: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      data-slot="contribution-action"
      data-advice-state={state}
      className="min-w-0 space-y-2 text-sm [overflow-wrap:anywhere]"
    >
      {state === 'available' ? (
        children
      ) : (
        <p role={state === 'failed' ? 'alert' : 'status'}>{adviceText(state, locale)}</p>
      )}
      {state === 'failed' && retry ? (
        <Button type="button" variant="outline" onClick={() => void retry()}>
          {m.public_account_retry({}, { locale })}
        </Button>
      ) : null}
    </section>
  );
}

/** Post watch uses its containing thread. ThreadWatch alone owns the point command and uncertain recovery. */
export function ContributionWatch({
  presentation,
  watching,
  returnTo,
  refreshAdvice,
  native,
}: {
  presentation: ContributionPresentation;
  watching: boolean;
  returnTo: string;
  refreshAdvice?: ThreadWatchProps['refreshAdvice'];
  native?: ThreadWatchProps['native'];
}) {
  const { input, row, source, reader, isCurrent, locale } = presentation;
  const reference = originalContributionReference(input, row);
  const state = !isCurrent()
    ? 'retired'
    : presentation.failed
      ? 'failed'
      : reference
        ? contributionOperationAdvice({
            reference,
            operation: 'watch',
            action: 'thread:watch',
            operationId: watching ? 'thread.unwatch' : 'thread.watch',
            source,
            reader,
            isCurrent,
          })
        : 'unavailable';
  const lease = state === 'available' ? presentation.operation('watch') : undefined;
  const ready = !!lease && lease.reader === reader && lease.operation === 'watch' && lease.current();
  const target = reference ? contributionCommandTarget(reference, 'watch') : undefined;
  return (
    <ContributionAdvicePresentation
      state={state === 'available' && !ready ? 'unavailable' : state}
      label={m.thread_watch_watch({}, { locale })}
      locale={locale}
      retry={refreshAdvice}
    >
      {ready && target && reader ? (
        <ThreadWatch
          threadId={target.id}
          session="signed-in"
          sessionKnown
          viewerId={reader}
          sessionStamp={JSON.stringify([input.accountId, input.view, input.cursor, input.proof, target])}
          admitted
          initialWatching={watching}
          returnTo={returnTo}
          {...(source ? { readAuthority: source } : {})}
          isCurrent={lease.current}
          {...(refreshAdvice ? { refreshAdvice } : {})}
          {...(native ? { native } : {})}
        />
      ) : null}
    </ContributionAdvicePresentation>
  );
}
