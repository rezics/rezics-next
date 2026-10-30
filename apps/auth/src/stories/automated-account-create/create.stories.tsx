import { useLayoutEffect, type ReactNode } from 'react';
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
function Fixture({ children, mode }: { children: ReactNode; mode: 'confirm' | 'foreign' | 'lost' | 'pending' }) {
  useLayoutEffect(() => {
    const key = 'rezics.automated-create.attempt';
    const previous = sessionStorage.getItem(key);
    const original = globalThis.fetch;
    sessionStorage.removeItem(key);
    saveAutomatedAttempt(createAutomatedAttempt(human, operator, 'operated_actor')!);
    globalThis.fetch = (async (url, init) => {
      const path = String(url);
      if (path === '/session')
        return Response.json({
          account_id: human,
          ...AUTOMATED_PROFILE,
          authn_epoch: 1,
          auth_time: Math.floor(Date.now() / 1000),
          amr: ['pwd'],
        });
      if (path.endsWith('/approve'))
        return mode === 'foreign'
          ? Response.json({ error: 'account_operation_denied' }, { status: 403 })
          : Response.json({ reference: 'native-approval', expiresAt: '2030-01-01T00:00:00Z' });
      if (path.endsWith('/execute')) {
        if (mode === 'lost') throw new TypeError('Story: response lost');
        return Response.json({ accountId: human, registrationId: 'pending' });
      }
      return original(url, init);
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
      if (previous === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, previous);
    };
  }, [mode]);
  return <AuthShell>{children}</AuthShell>;
}
const page = (mode: 'confirm' | 'foreign' | 'lost' | 'pending') => (
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
export const Confirmation = { render: () => page('confirm') };
export const ForeignDenial = {
  render: () => page('foreign'),
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
