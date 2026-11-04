import { useLayoutEffect, useState } from 'react';
import { AutomatedAccountCreatePage } from '../../../routes/automated.new';
import { AuthShell } from '../../../frame';
import { AUTOMATED_PROFILE, createAutomatedAttempt, saveAutomatedAttempt } from '../../../automated-account-create';
import { authLocale, button, fill, reviewParameters, waitFor } from '../../accounts-operations/story';
import { m } from '../../../paraglide/messages.js';

export default {
  title: 'Pages/Accounts operations/Automated/Creation browser return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

const human = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'organization' as const,
  handle: null,
  displayName: 'Current organization operator',
};
const profile = {
  account_id: human,
  client_id: AUTOMATED_PROFILE.client_id,
  scope: AUTOMATED_PROFILE.scope,
  auth_time: Math.floor(Date.now() / 1000),
  authn_epoch: 1,
  amr: ['pwd'],
};
type Mode = 'interrupted' | 'unknown' | 'acknowledged' | 'unknown-acknowledged' | 'unavailable';

function Fixture({ mode, dark }: { mode: Mode; dark: boolean }) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const key = 'rezics.automated-create.attempt';
    const previous = window.sessionStorage.getItem(key);
    const original = globalThis.fetch;
    let pageReads = 0;
    window.sessionStorage.removeItem(key);
    if (mode === 'unknown' || mode === 'unknown-acknowledged' || mode === 'unavailable') {
      const attempt = createAutomatedAttempt(human, operator, 'story-handle')!;
      saveAutomatedAttempt({ ...attempt, reference: 'story-reference', submitted: true });
    }
    globalThis.fetch = (async (input, init) => {
      const path = String(input);
      if (path === '/session') return Response.json(profile);
      if (path === '/account-management/automated/operator') {
        pageReads++;
        if (mode === 'unavailable' && pageReads > 1) return new Response(null, { status: 503 });
        const body = JSON.parse(String(init?.body));
        const selected = body.operatorAccountId !== null;
        return Response.json({
          viewer: { accountId: human },
          readiness: selected ? 'review' : 'select-operator',
          operator: selected ? operator : null,
          handleRules: {
            minLength: 3,
            maxLength: 64,
            normalization: 'lowercase',
            pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
          },
          action: selected ? 'confirm' : 'select-operator',
        });
      }
      if (path === '/account-operations/approve')
        return Response.json({ reference: 'story-reference', expiresAt: '2030-01-01T00:00:00Z' });
      if (path === '/account-operations/execute')
        return Response.json({ accountId: '33333333-3333-4333-8333-333333333333' });
      throw new Error(`Unexpected story request: ${path}`);
    }) as typeof fetch;
    setReady(true);
    return () => {
      globalThis.fetch = original;
      if (previous === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, previous);
    };
  }, [mode]);
  return (
    <div className={dark ? 'dark min-h-screen bg-background text-foreground' : 'min-h-screen bg-background text-foreground'}>
      <AuthShell>{ready ? <AutomatedAccountCreatePage /> : null}</AuthShell>
    </div>
  );
}

const page = (mode: Mode, dark = false) => <Fixture mode={mode} dark={dark} />;
const phone = { ...reviewParameters, viewport: { ...reviewParameters.viewport, defaultViewport: 'phone390' } };
const desktop = { ...reviewParameters, viewport: { ...reviewParameters.viewport, defaultViewport: 'desktop1280' } };

async function retire(canvas: HTMLElement) {
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  await waitFor(() => canvas.querySelector('#automated-return-heading'));
  if (canvas.querySelector('#automated-confirm')) throw new Error('Private review must be cleared before caching.');
}
async function confirm(canvas: HTMLElement) {
  (await waitFor(() => canvas.querySelector<HTMLInputElement>('#automated-confirm'))).click();
  const submit = await waitFor(() => {
    const action = button(canvas, m.auth_automated_submit());
    return action && !action.disabled ? action : null;
  });
  submit.click();
}

export const InterruptedPhoneDark = {
  parameters: phone,
  render: () => page('interrupted', true),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    fill(canvasElement.querySelector<HTMLInputElement>('#automated-handle')!, 'story-private-handle');
    await retire(canvasElement);
  },
};
export const PossiblySentDesktopLight = {
  parameters: desktop,
  render: () => page('unknown'),
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => retire(canvasElement),
};
export const AcknowledgedPhoneLight = {
  parameters: phone,
  render: () => page('acknowledged'),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    fill(canvasElement.querySelector<HTMLInputElement>('#automated-operator')!, operator.id);
    fill(canvasElement.querySelector<HTMLInputElement>('#automated-handle')!, 'story-handle');
    button(canvasElement, m.auth_automated_review())!.click();
    await waitFor(() => canvasElement.querySelector('#automated-confirm'));
    await confirm(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_automated_history_acknowledged()));
    await retire(canvasElement);
  },
};
export const UnknownAndAcknowledgedDesktopDark = {
  parameters: desktop,
  render: () => page('unknown-acknowledged', true),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => canvasElement.querySelector('#automated-confirm'));
    await confirm(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_automated_history_acknowledged()));
    await retire(canvasElement);
  },
};
export const UnknownWithUnavailableReturnPhoneDark = {
  parameters: phone,
  render: () => page('unavailable', true),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => canvasElement.querySelector('#automated-confirm'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(() => canvasElement.textContent?.includes(m.auth_automated_unavailable()));
    if (canvasElement.querySelector('#automated-confirm')) throw new Error('Unavailable return exposed private review.');
  },
};
