import { useLayoutEffect, useState } from 'react';
import { AuthShell } from '../../../frame';
import { OperatorTransferPage } from '../../../routes/operators.transfer';
import { OPERATOR_MANAGEMENT_PROFILE, storeTransferAttempt, type TransferAttempt } from '../../../operator-transfer';
import { authLocale, button, reviewParameters, waitFor } from '../story';
import { m } from '../../../paraglide/messages.js';

export default {
  title: 'Account/Operators/Transfer browser return',
  id: 'pages-accounts-operations-operators-transfer-browser-return',
  parameters: reviewParameters,
  decorators: [authLocale],
};
const owner = {
  kind: 'ready' as const,
  accountId: 'story-human',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: ['account:manage'],
};
const saved: TransferAttempt = {
  accountId: owner.accountId,
  side: 'source',
  phase: 'readback',
  reference: 'story-reference',
  acceptance: 'story-acceptance',
  request: {
    version: 1,
    previous: { subjectAccountId: 'story-subject', operatorAccountId: 'story-source', reservationId: 'story-slot' },
    expectedVersion: '12',
    operatorAccountId: 'story-destination',
    sourceOperationKey: 'story-key',
  },
};
/** Actual route over story-only read responses; browser/native acceptance remains separate. */
function ReturnStory({
  phase = 'readback',
  unavailable = false,
}: {
  phase?: TransferAttempt['phase'];
  unavailable?: boolean;
}) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const previous = window.sessionStorage.getItem('rezics.operator-transfer.attempt');
    const fetch = globalThis.fetch;
    storeTransferAttempt({ ...saved, side: phase === 'accepted' ? 'destination' : 'source', phase });
    globalThis.fetch = (async (input, init) => {
      if (String(input) === '/session')
        return Response.json({ account_id: owner.accountId, client_id: owner.clientId, scope: owner.scopes });
      if (String(input) !== '/account-management/operators/transfer-review')
        throw new Error(`Unexpected story request: ${input}`);
      const body = JSON.parse(String(init?.body));
      if (body.kind === 'readiness') return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } });
      if (unavailable) return new Response(null, { status: 503 });
      return Response.json({
        viewer: { kind: 'ready' },
        review:
          body.kind === 'destination'
            ? { kind: 'destination', destinationAccountId: saved.request.operatorAccountId, action: 'allowed' }
            : {
                kind: 'source',
                action: 'allowed',
                relation: {
                  previous: {
                    ...saved.request.previous,
                    operatorAccountId: saved.request.operatorAccountId,
                    reservationId: 'new-slot',
                  },
                  expectedVersion: '13',
                },
              },
      });
    }) as typeof fetch;
    setReady(true);
    return () => {
      globalThis.fetch = fetch;
      if (previous === null) window.sessionStorage.removeItem('rezics.operator-transfer.attempt');
      else window.sessionStorage.setItem('rezics.operator-transfer.attempt', previous);
    };
  }, [phase, unavailable]);
  return (
    <div className="bg-background text-foreground">
      {ready ? (
        <AuthShell>
          <OperatorTransferPage initial={owner} />
        </AuthShell>
      ) : null}
    </div>
  );
}
async function review({ canvasElement }: { canvasElement: HTMLElement }) {
  const action = await waitFor(() => button(canvasElement, m.auth_transfer_recovery_review()));
  action.click();
}

export const Acknowledged = { parameters: reviewParameters, render: () => <ReturnStory />, play: review };
export const AcknowledgedReadUnavailable = {
  parameters: reviewParameters,
  render: () => <ReturnStory unavailable />,
  play: review,
};
export const UnknownMatching = {
  parameters: reviewParameters,
  render: () => <ReturnStory phase="execute" />,
  play: review,
};
export const DestinationAcceptance = {
  parameters: reviewParameters,
  render: () => <ReturnStory phase="accepted" />,
  play: review,
};
export const SavedReview = { parameters: reviewParameters, render: () => <ReturnStory phase="approve" /> };
export const CachedReturn = {
  parameters: reviewParameters,
  render: () => <ReturnStory />,
  play: async (context: { canvasElement: HTMLElement }) => {
    await review(context);
    await waitFor(() => context.canvasElement.querySelector('#transfer-acknowledgment'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    if (context.canvasElement.querySelector('#transfer-acknowledgment'))
      throw new Error('Private review must be removed synchronously.');
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  },
};
