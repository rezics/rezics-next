import { m } from '../../../paraglide/messages.js';
import { ThreadReactions, type ThreadReactionsProps } from '../../../threads/thread-reactions';
import { contributionOperationAdvice, originalContributionReference } from './advice';
import { ContributionAdvicePresentation, type ContributionPresentation } from './presentation';

/** Prepared native composition. Only the official contribution adapter may supply production slots. */
export function ContributionReaction({
  presentation,
  counts,
  value,
  returnTo,
  refreshAdvice,
  preparedTransport,
  ...watermark
}: {
  presentation: ContributionPresentation;
  counts: ThreadReactionsProps['counts'];
  value: ThreadReactionsProps['value'];
  returnTo: string;
  refreshAdvice?: (() => Promise<void>) | undefined;
  preparedTransport?: ThreadReactionsProps['preparedTransport'];
  sourceWatermark?: ThreadReactionsProps['sourceWatermark'];
}) {
  const { input, row, source, reader, isCurrent, locale } = presentation;
  const reference = originalContributionReference(input, row);
  const kind = reference?.type === 'content.post' ? 'post' : 'thread';
  // The native picker can both select and clear. Neither command may borrow the other's advice.
  const states = (['set', 'clear'] as const).map((operation) =>
    !isCurrent()
      ? 'retired'
      : presentation.failed
        ? 'failed'
        : reference
          ? contributionOperationAdvice({
              reference,
              operation: 'reaction',
              action: 'reaction:set',
              operationId: `${kind}.${operation}_reaction`,
              source,
              reader,
              isCurrent,
            })
          : 'unavailable',
  );
  const state = states.find((state) => state !== 'available') ?? 'available';
  const lease = state === 'available' ? presentation.operation('reaction') : undefined;
  const ready = !!reader && !!lease && lease.reader === reader && lease.operation === 'reaction' && lease.current();
  return (
    <ContributionAdvicePresentation
      state={state === 'available' && !ready ? 'unavailable' : state}
      label={m.reaction_reactions({}, { locale })}
      locale={locale}
      retry={refreshAdvice}
    >
      {ready && reference ? (
        <ThreadReactions
          target={{ kind, id: reference.id }}
          counts={counts}
          value={value}
          signedIn
          personalReady
          returnTo={returnTo}
          locale={locale}
          optimistic={false}
          settleWithRead
          reactionOrigin={{
            key: JSON.stringify([input.accountId, input.view, input.cursor, input.proof, reference]),
            reader,
            isCurrent: () => isCurrent() && lease.current(),
          }}
          {...watermark}
          {...(refreshAdvice ? { onMutation: refreshAdvice } : {})}
          {...(preparedTransport ? { preparedTransport } : {})}
        />
      ) : null}
    </ContributionAdvicePresentation>
  );
}
