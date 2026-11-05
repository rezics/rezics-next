import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { creationFixture, button, dom } from './creation-page-fixture';
creationFixture();
const { createRoot } = await import('react-dom/client');
const { OperatorTransferPage } = await import('../src/routes/operators.transfer');
const { storeTransferAttempt, restoreTransferAttempt, OPERATOR_MANAGEMENT_PROFILE } =
  await import('../src/operator-transfer');
const { m } = await import('../src/paraglide/messages.js');

test.each(['readback', 'execute', 'destination'] as const)(
  'retired %s Retry preserves refused advice, exact selection and zero commands',
  async (phase) => {
    const request = {
      version: 1 as const,
      previous: { subjectAccountId: 'subject', operatorAccountId: 'source', reservationId: 'slot' },
      expectedVersion: '1',
      operatorAccountId: 'destination',
      sourceOperationKey: 'original-key',
    };
    storeTransferAttempt({
      accountId: 'human',
      side: phase === 'destination' ? 'destination' : 'source',
      phase: phase === 'destination' ? 'accepted' : phase,
      request,
      reference: 'reference',
      ...(phase === 'destination' ? {} : { acceptance: 'acceptance' }),
    });
    const saved = restoreTransferAttempt();
    let selectedReads = 0;
    const calls: { path: string; body: any }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const path = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body });
      if (path === '/session')
        return Response.json({
          account_id: 'human',
          client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
          scope: ['account:manage'],
        });
      if (path === '/account-management/operators/transfer-review') {
        if (body.kind !== 'readiness' && ++selectedReads === 1) return new Response('{invalid');
        return Response.json({
          viewer: { kind: 'ready' },
          review:
            body.kind === 'readiness'
              ? { kind: 'readiness' }
              : body.kind === 'source'
                ? { kind: 'source', relation: { previous: request.previous, expectedVersion: '1' }, action: 'allowed' }
                : { kind: 'destination', destinationAccountId: request.operatorAccountId, action: 'allowed' },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const host = document.body.appendChild(document.createElement('div'));
    const root = createRoot(host);
    const settle = (action: () => void) =>
      act(async () => {
        action();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
    try {
      await settle(() => root.render(createElement(OperatorTransferPage)));
      expect(calls.map(({ path }) => path)).toEqual([
        '/session',
        '/session',
        '/account-management/operators/transfer-review',
      ]);
      await settle(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
      calls.length = 0;
      await settle(() => {
        const review = button(host, m.auth_transfer_recovery_review());
        review.click();
        review.click();
      });
      expect(calls.map(({ path }) => path)).toEqual([
        '/session',
        '/session',
        '/account-management/operators/transfer-review',
        '/session',
        '/account-management/operators/transfer-review',
      ]);
      const selection =
        phase === 'destination' ? { kind: 'destination', request } : { kind: 'source', subjectAccountId: 'subject' };
      expect(calls.filter(({ body }) => body?.kind === selection.kind).map(({ body }) => body)).toEqual([selection]);
      expect(host.textContent).toContain(m.auth_transfer_recovery_unavailable());
      expect(restoreTransferAttempt()).toEqual(saved);
      await settle(() => button(host, m.auth_transfer_recovery_retry()).click());
      expect(calls.slice(-2).map(({ path }) => path)).toEqual([
        '/session',
        '/account-management/operators/transfer-review',
      ]);
      expect(calls.at(-1)?.body).toEqual(selection);
      expect(restoreTransferAttempt()).toEqual(saved);
      expect(calls.some(({ path }) => path.startsWith('/account-operations/'))).toBe(false);
      if (phase === 'readback') {
        expect(host.textContent).toContain(m.auth_transfer_recovery_acknowledged());
        expect(host.textContent).not.toContain(m.auth_transfer_recovery_source_unknown());
      } else if (phase === 'execute') {
        expect(host.textContent).toContain(m.auth_transfer_recovery_source_unknown());
        expect(host.textContent).not.toContain(m.auth_transfer_recovery_acknowledged());
      } else expect(host.textContent).toContain(m.auth_transfer_recovery_destination());
    } finally {
      await settle(() => root.unmount());
      host.remove();
      globalThis.fetch = original;
    }
  },
);
