import { useLayoutEffect, useMemo, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { Route } from '../../routes/login';
import { AuthShell } from '../../frame';
import { LoginReturnView } from '../../login-return-view';
import { m } from '../../paraglide/messages.js';
import { authLocale, reviewParameters, button, fill, waitFor } from '../accounts-operations/story';
import '../../styles.css';

export default { title: 'Pages/Account/Sign in/Return', parameters: reviewParameters, decorators: [authLocale] };

type Mode = 'dispatched' | 'read-failure' | 'keyboard';
// Mounted route fixtures. They demonstrate presentation; browser/native acceptance is deferred.
function Page({ mode }: { mode: Mode }) {
  const [installed, setInstalled] = useState(false);
  const router = useMemo(() => {
    const parent = createRootRoute({
      component: () => (
        <AuthShell>
          <Outlet />
        </AuthShell>
      ),
    });
    const login = createRoute({ getParentRoute: () => parent, path: '/login', component: Route.options.component! });
    return createRouter({
      history: createMemoryHistory({ initialEntries: ['/login?return_to=%2Fsecurity'] }),
      routeTree: parent.addChildren([login]),
    });
  }, []);
  useLayoutEffect(() => {
    const original = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (input, init) => {
      if (input === '/signin/page') {
        if (++reads > 1 && mode === 'read-failure') return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({
          methods: { password: true, passkey: false },
          viewer:
            mode === 'keyboard'
              ? { kind: 'signed-in', account_id: 'story', email: 'reader@example.test' }
              : { kind: 'signed-out' },
          continuation: { href: '/security', requires_sign_in: false },
        });
      }
      if (input === '/signin') {
        queueMicrotask(() => window.dispatchEvent(new Event('pagehide')));
        return new Promise<Response>(() => {});
      }
      return original(input, init);
    }) as typeof fetch;
    setInstalled(true);
    return () => {
      globalThis.fetch = original;
    };
  }, [mode]);
  return installed ? <RouterProvider router={router} /> : null;
}
const interrupt = async (canvas: HTMLElement) => {
  await waitFor(() => canvas.querySelector('#login-password'));
  fill(canvas.querySelector<HTMLInputElement>('#login-email')!, 'reader@example.test');
  fill(canvas.querySelector<HTMLInputElement>('#login-password')!, 'story-password');
  await waitFor(() => canvas.querySelector<HTMLInputElement>('#login-password')?.value === 'story-password');
  button(canvas, m.auth_login_heading())!.click();
  await waitFor(() => canvas.textContent?.includes(m.auth_login_return_heading()));
};
export const PagehideAfterDispatch = {
  render: () => <Page mode="dispatched" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => interrupt(canvasElement),
};
export const RepeatedNativeReadFailure = {
  render: () => <Page mode="read-failure" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await interrupt(canvasElement);
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    (await waitFor(() => button(canvasElement, m.auth_login_page_retry())))!.click();
    await waitFor(() => button(canvasElement, m.auth_login_page_retry()));
  },
};
export const KeyboardMethodSwitching = {
  render: () => <Page mode="keyboard" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const change = (await waitFor(() => button(canvasElement, m.auth_login_switch_account())))!;
    change.focus();
    change.click();
    const email = (await waitFor(() => canvasElement.querySelector<HTMLInputElement>('#login-email')))!;
    email.focus();
    fill(email, 'reader@example.test');
    canvasElement.querySelector<HTMLInputElement>('#login-password')!.focus();
    button(canvasElement, m.auth_login_heading())!.focus();
  },
};
// These exact nonsecret states use the production return view without browser ceremony simulation.
const Historical = ({
  method,
  phase,
}: {
  method: 'passkey' | 'autofill';
  phase: 'options' | 'prompt' | 'acknowledged';
}) => (
  <AuthShell>
    <LoginReturnView records={[{ method, phase }]} onDismiss={() => {}} />
  </AuthShell>
);
export const ExplicitButtonBeforeDispatch = { render: () => <Historical method="passkey" phase="options" /> };
export const BrowserAutofillBeforeDispatch = { render: () => <Historical method="autofill" phase="prompt" /> };
export const SuccessBeforeReadRetirement = { render: () => <Historical method="passkey" phase="acknowledged" /> };
