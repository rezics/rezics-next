import { useLayoutEffect, type ReactNode } from 'react';
import { OperatorTransferPage } from '../../routes/operators.transfer';
import { AuthShell } from '../../frame';
import {
  OPERATOR_MANAGEMENT_PROFILE,
  OPERATOR_RELATION_PATH,
  storeTransferAttempt,
  type TransferAttempt,
} from '../../operator-transfer';
import { authLocale, reviewParameters, button, waitFor } from '../accounts-operations/story';
import { m } from '../../paraglide/messages.js';

export default { title: 'Pages/Account/Operator transfer', parameters: reviewParameters, decorators: [authLocale] };
const session = {
  kind: 'ready' as const,
  accountId: 'story-human',
  clientId: OPERATOR_MANAGEMENT_PROFILE.client_id,
  scopes: ['account:manage'],
};
const source: TransferAttempt = {
  accountId: session.accountId,
  side: 'source',
  phase: 'approve',
  request: {
    version: 1,
    previous: {
      operatorAccountId: 'current-operator',
      subjectAccountId: 'operated-account',
      reservationId: 'current-reservation',
    },
    expectedVersion: '12',
    operatorAccountId: 'destination-operator',
    sourceOperationKey: 'original-source-key',
  },
};
// Presentation fixtures only: no native/runtime acceptance claim.
function Fixture({
  children,
  attempt,
  mode = 'unavailable',
}: {
  children: ReactNode;
  attempt?: TransferAttempt;
  mode?: 'unavailable' | 'denied' | 'conflict' | 'uncertain';
}) {
  useLayoutEffect(() => {
    const saved = sessionStorage.getItem('rezics.operator-transfer.attempt');
    const original = globalThis.fetch;
    sessionStorage.removeItem('rezics.operator-transfer.attempt');
    if (attempt) storeTransferAttempt(structuredClone(attempt));
    globalThis.fetch = (async (input, init) => {
      const path = String(input);
      if (path === '/session')
        return Response.json({ account_id: session.accountId, client_id: session.clientId, scope: session.scopes });
      if (path === OPERATOR_RELATION_PATH)
        return mode === 'unavailable'
          ? new Response(null, { status: 404 })
          : Response.json({ previous: source.request.previous, expectedVersion: source.request.expectedVersion });
      if (path === '/account-operations/approve')
        return mode === 'uncertain'
          ? Response.json({ reference: 'opaque-source-approval', expiresAt: '2030-01-01T00:00:00Z' })
          : Response.json({ error: 'account_operation_denied' }, { status: mode === 'conflict' ? 409 : 403 });
      if (path === '/account-operations/execute') throw new TypeError('Story: response lost');
      return original(input, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
      if (saved === null) sessionStorage.removeItem('rezics.operator-transfer.attempt');
      else sessionStorage.setItem('rezics.operator-transfer.attempt', saved);
    };
  }, [attempt, mode]);
  return <AuthShell>{children}</AuthShell>;
}
const page = (attempt?: TransferAttempt, mode?: 'unavailable' | 'denied' | 'conflict' | 'uncertain') => (
  <Fixture {...(attempt ? { attempt } : {})} {...(mode ? { mode } : {})}>
    <OperatorTransferPage initial={session} />
  </Fixture>
);
async function submit(canvas: HTMLElement) {
  const confirmation = await waitFor(() => canvas.querySelector<HTMLInputElement>('#transfer-confirm'));
  confirmation.click();
  await waitFor(() => !button(canvas, m.auth_transfer_submit())?.disabled);
  button(canvas, m.auth_transfer_submit())!.click();
}
export const IndependentForms = { render: () => page() };
export const SourceRequest = { render: () => page(source) };
export const DestinationReview = { render: () => page({ ...source, side: 'destination' }) };
export const DestinationAccepted = {
  render: () => page({ ...source, side: 'destination', phase: 'accepted', reference: 'opaque-destination-acceptance' }),
};
export const SameAccountReconfirmation = {
  render: () => (
    <Fixture attempt={source}>
      <OperatorTransferPage initial={{ kind: 'ready', accountId: session.accountId, clientId: 'login', scopes: [] }} />
    </Fixture>
  ),
};
export const DependencyUnavailable = {
  render: () => page({ ...source, acceptance: 'opaque-acceptance' }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_transfer_unavailable()));
  },
};
export const Refused = {
  render: () => page({ ...source, acceptance: 'opaque-acceptance' }, 'denied'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_transfer_denied()));
  },
};
export const NativeConflict = {
  render: () => page({ ...source, acceptance: 'opaque-acceptance' }, 'conflict'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_transfer_conflict()));
  },
};
export const LostResponse = {
  render: () => page({ ...source, acceptance: 'opaque-acceptance' }, 'uncertain'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_transfer_uncertain()));
  },
};
export const SignedOut = {
  render: () => (
    <Fixture>
      <OperatorTransferPage initial={{ kind: 'signed-out' }} />
    </Fixture>
  ),
};
