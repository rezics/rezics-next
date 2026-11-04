import { useLayoutEffect, useState, type ReactNode } from 'react';
import { OperatorTransferPage } from '../../routes/operators.transfer';
import { AuthShell } from '../../frame';
import { OPERATOR_MANAGEMENT_PROFILE, storeTransferAttempt, type TransferAttempt } from '../../operator-transfer';
import { OPERATOR_TRANSFER_PAGE_PATH } from '../../operator-transfer-page';
import { authLocale, reviewParameters, button, waitFor } from '../accounts-operations/story';
import { m } from '../../paraglide/messages.js';

export default {
  title: 'Pages/Account/Operator transfer',
  parameters: {
    ...reviewParameters,
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '1000px' } },
      },
    },
    rezicsReview: {
      pageIdentity: '/operators/transfer',
      fixtureProvenance: 'Story-only fetch and sessionStorage fixture; no native authorization claim.',
      source: 'Current Storybook build of the worktree source.',
    },
  },
  decorators: [authLocale],
};
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
  tone = 'light',
}: {
  children: ReactNode;
  attempt?: TransferAttempt;
  mode?: 'ready' | 'unavailable' | 'denied' | 'conflict' | 'uncertain';
  tone?: 'light' | 'dark';
}) {
  const [fixtureReady, setFixtureReady] = useState(false);
  useLayoutEffect(() => {
    const saved = sessionStorage.getItem('rezics.operator-transfer.attempt');
    const original = globalThis.fetch;
    sessionStorage.removeItem('rezics.operator-transfer.attempt');
    if (attempt) storeTransferAttempt(structuredClone(attempt));
    let transferred = false;
    globalThis.fetch = (async (input, init) => {
      const path = String(input);
      if (path === '/session')
        return Response.json({ account_id: session.accountId, client_id: session.clientId, scope: session.scopes });
      if (path === OPERATOR_TRANSFER_PAGE_PATH) {
        const input = JSON.parse(String(init?.body));
        if (input.kind === 'readiness')
          return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'readiness' } });
        if (mode === 'unavailable') return new Response(null, { status: 503 });
        if (input.kind === 'source') {
          if (mode === 'denied') return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'refused' } });
          if (mode === 'conflict') return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'changed' } });
          const relation = transferred
            ? {
                previous: {
                  ...source.request.previous,
                  operatorAccountId: source.request.operatorAccountId,
                  reservationId: 'new-reservation',
                },
                expectedVersion: '13',
              }
            : { previous: source.request.previous, expectedVersion: source.request.expectedVersion };
          return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'source', relation, action: 'allowed' } });
        }
        if (input.kind === 'destination') {
          if (mode === 'denied')
            return Response.json({
              viewer: { kind: 'ready' },
              review: { kind: 'destination', destinationAccountId: input.request.operatorAccountId, action: 'denied' },
            });
          if (mode === 'conflict') return Response.json({ viewer: { kind: 'ready' }, review: { kind: 'changed' } });
          return Response.json({
            viewer: { kind: 'ready' },
            review: { kind: 'destination', destinationAccountId: input.request.operatorAccountId, action: 'allowed' },
          });
        }
      }
      if (path === '/account-operations/approve')
        return mode === 'uncertain' || mode === 'ready'
          ? Response.json({
              reference:
                JSON.parse(String(init?.body)).operation.kind === 'transfer-acceptance'
                  ? 'opaque-destination-acceptance'
                  : 'opaque-source-approval',
              expiresAt: '2030-01-01T00:00:00Z',
            })
          : Response.json({ error: 'account_operation_denied' }, { status: mode === 'conflict' ? 409 : 403 });
      if (path === '/account-operations/execute') {
        if (mode === 'uncertain') throw new TypeError('Story: response lost');
        if (mode === 'ready') {
          transferred = true;
          return Response.json({ accountId: source.request.previous.subjectAccountId });
        }
      }
      return original(input, init);
    }) as typeof fetch;
    setFixtureReady(true);
    return () => {
      globalThis.fetch = original;
      if (saved === null) sessionStorage.removeItem('rezics.operator-transfer.attempt');
      else sessionStorage.setItem('rezics.operator-transfer.attempt', saved);
    };
  }, [attempt, mode]);
  return (
    <div className={tone === 'dark' ? 'dark' : ''} data-fixture-tone={tone}>
      {fixtureReady ? <AuthShell>{children}</AuthShell> : null}
    </div>
  );
}
const page = (attempt?: TransferAttempt, mode?: 'ready' | 'unavailable' | 'denied' | 'conflict' | 'uncertain') => (
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
async function hierarchy(canvas: HTMLElement, selector: string) {
  const action = await waitFor(() => canvas.querySelector<HTMLElement>(selector));
  const summary = [...canvas.querySelectorAll('summary')].find(
    (entry) => entry.textContent === m.auth_transfer_guide_heading(),
  );
  const guide = summary?.parentElement as HTMLDetailsElement | undefined;
  if (!guide || guide.open || !(action.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING))
    throw new Error('The participant entry must precede the closed handoff guide.');
  const controls = [...canvas.querySelectorAll('input, textarea, button, a, summary')];
  for (let repeat = 0; repeat < 3; repeat++) {
    summary!.focus();
    if (document.activeElement !== summary) throw new Error('The guide summary must accept keyboard focus.');
    summary!.click();
    if (!guide.open || guide.querySelectorAll('ol > li').length !== 4)
      throw new Error('The complete four-step handoff must remain reachable.');
    summary!.click();
    const currentControls = [...canvas.querySelectorAll('input, textarea, button, a, summary')];
    if (
      guide.open ||
      controls.length !== currentControls.length ||
      controls.some((control, index) => currentControls[index] !== control)
    )
      throw new Error('Opening the guide must preserve the participant controls.');
  }
  for (const file of canvas.querySelectorAll('input[type="file"]')) {
    for (const id of file.getAttribute('aria-describedby')!.split(' ')) {
      const target = canvas.querySelectorAll(`[id="${id}"]`);
      if (target.length !== 1 || target[0]!.closest('details'))
        throw new Error('File guidance and feedback must resolve uniquely outside closed disclosures.');
    }
  }
}
export const IndependentForms = {
  render: () => page(undefined, 'ready'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await hierarchy(canvasElement, '#transfer-subject');
    await hierarchy(canvasElement, '#transfer-request-file');
  },
};
export const SourceRequest = {
  render: () => page(source, 'ready'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => hierarchy(canvasElement, '#transfer-confirm'),
};
export const DestinationReview = {
  render: () => page({ ...source, side: 'destination' }, 'ready'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => hierarchy(canvasElement, '#transfer-confirm'),
};
export const DarkDestinationReview = {
  render: () => (
    <Fixture attempt={{ ...source, side: 'destination' }} mode="ready" tone="dark">
      <OperatorTransferPage initial={session} />
    </Fixture>
  ),
};
export const LongTraditionalChinese = {
  globals: { locale: 'zh-Hant' },
  render: () => page({ ...source, side: 'destination' }, 'ready'),
};
export const LongJapanese = {
  globals: { locale: 'ja' },
  render: () => page({ ...source, side: 'destination' }, 'ready'),
};
export const UncertainRestore = {
  render: () =>
    page({ ...source, phase: 'execute', acceptance: 'opaque-acceptance', reference: 'original-approval' }, 'ready'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await hierarchy(canvasElement, '#transfer-confirm');
    if (!canvasElement.querySelector('[role="alert"]')?.textContent?.includes(m.auth_transfer_uncertain()))
      throw new Error('The restored uncertain result must remain visible outside the guide.');
  },
};
export const LongIdentifiers = {
  render: () =>
    page(
      {
        ...source,
        request: {
          ...source.request,
          previous: {
            ...source.request.previous,
            subjectAccountId: 'subject-' + 'a'.repeat(120),
            operatorAccountId: 'source-' + 'b'.repeat(120),
          },
          operatorAccountId: 'destination-' + 'c'.repeat(116),
        },
      },
      'ready',
    ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => hierarchy(canvasElement, '#transfer-confirm'),
};
export const DestinationAccepted = {
  render: () => page({ ...source, side: 'destination', phase: 'accepted', reference: 'opaque-destination-acceptance' }),
};
export const SameAccountReconfirmation = {
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => hierarchy(canvasElement, '#transfer-email'),
  render: () => (
    <Fixture attempt={source}>
      <OperatorTransferPage initial={{ kind: 'ready', accountId: session.accountId, clientId: 'login', scopes: [] }} />
    </Fixture>
  ),
};
export const DependencyUnavailable = {
  render: () => page({ ...source, acceptance: 'opaque-acceptance' }),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => canvasElement.textContent?.includes(m.auth_transfer_unavailable()));
  },
};
export const Refused = {
  render: () => page({ ...source, acceptance: 'opaque-acceptance' }, 'denied'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => canvasElement.textContent?.includes(m.auth_transfer_denied()));
  },
};
export const NativeConflict = {
  render: () => page({ ...source, acceptance: 'opaque-acceptance' }, 'conflict'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
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
