import { useLayoutEffect, useState, type ReactNode } from 'react';
import { AutomatedAccountCreatePage } from '../../routes/automated.new';
import { AuthShell } from '../../frame';
import { AUTOMATED_PROFILE, createAutomatedAttempt, saveAutomatedAttempt } from '../../automated-account-create';
import { authLocale, reviewParameters, button, waitFor } from '../accounts-operations/story';
import { m } from '../../paraglide/messages.js';

export default { title: 'Pages/Account/Create operated actor', parameters: reviewParameters, decorators: [authLocale] };
const human = '11111111-1111-4111-8111-111111111111';
const operator = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'organization' as const,
  handle: 'native_operator',
  displayName: 'Native operator',
};
// Presentation fixtures; native integration evidence is the transport acceptance.
type Mode = 'review' | 'authentication-needed' | 'refused' | 'unavailable' | 'result' | 'lost' | 'pending';
function Fixture({ children, mode }: { children: ReactNode; mode: Mode }) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const key = 'rezics.automated-create.attempt';
    const previous = sessionStorage.getItem(key);
    const original = globalThis.fetch;
    sessionStorage.removeItem(key);
    if (mode !== 'authentication-needed')
      saveAutomatedAttempt(
        createAutomatedAttempt(human, { ...operator, displayName: null, handle: null }, 'operated_actor')!,
      );
    globalThis.fetch = (async (url, init) => {
      const path = String(url);
      if (path === '/session')
        return Response.json({
          account_id: human,
          ...AUTOMATED_PROFILE,
          ...(mode === 'authentication-needed' ? { client_id: 'login', scope: [] } : {}),
          authn_epoch: 1,
          auth_time: Math.floor(Date.now() / 1000),
          amr: ['pwd'],
        });
      if (path === '/account-management/automated/operator') {
        if (mode === 'unavailable') return Response.json({ error: 'unavailable' }, { status: 503 });
        const readiness = mode === 'authentication-needed' ? mode : mode === 'refused' ? mode : 'review';
        return Response.json({
          viewer: { accountId: human },
          readiness,
          operator: readiness === 'review' ? { ...operator, handle: null, displayName: null } : null,
          handleRules: {
            minLength: 3,
            maxLength: 64,
            normalization: 'lowercase',
            pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
          },
          action: readiness === 'review' ? 'confirm' : readiness === 'authentication-needed' ? 'authenticate' : 'none',
        });
      }
      if (path.endsWith('/approve'))
        return Response.json({ reference: 'native-approval', expiresAt: '2030-01-01T00:00:00Z' });
      if (path.endsWith('/execute')) {
        if (mode === 'lost') throw new TypeError('Story: response lost');
        return Response.json(
          mode === 'pending'
            ? { accountId: human, registrationId: 'pending' }
            : { accountId: '33333333-3333-4333-8333-333333333333' },
        );
      }
      return original(url, init);
    }) as typeof fetch;
    setReady(true);
    return () => {
      globalThis.fetch = original;
      if (previous === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, previous);
    };
  }, [mode]);
  return <AuthShell>{ready ? children : null}</AuthShell>;
}
const page = (mode: Mode) => (
  <Fixture mode={mode}>
    <AutomatedAccountCreatePage />
  </Fixture>
);
async function confirm(canvas: HTMLElement) {
  const checkbox = await waitFor(() => canvas.querySelector<HTMLInputElement>('#automated-confirm'));
  checkbox.click();
  await waitFor(() => !button(canvas, m.auth_automated_submit())?.disabled);
  button(canvas, m.auth_automated_submit())!.click();
}
export const Review = { render: () => page('review') };
export const AuthenticationNeeded = { render: () => page('authentication-needed') };
export const Refused = { render: () => page('refused') };
export const Unavailable = { render: () => page('unavailable') };
export const Result = {
  render: () => page('result'),
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => confirm(canvasElement),
};
export const LostResponse = {
  render: () => page('lost'),
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => confirm(canvasElement),
};
export const PendingIsNotComplete = {
  render: () => page('pending'),
  play: ({ canvasElement }: { canvasElement: HTMLElement }) => confirm(canvasElement),
};
