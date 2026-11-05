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
import { m } from '../../paraglide/messages.js';
import { authLocale, reviewParameters, button, fill, waitFor } from '../accounts-operations/story';
import '../../styles.css';

export default {
  title: 'Pages/Account/Sign in',
  parameters: {
    ...reviewParameters,
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
      },
    },
  },
  decorators: [authLocale],
};

type Mode = 'current' | 'switching' | 'pending' | 'changed' | 'unavailable' | 'uncertain';
// Presentation fixtures for the real route, not native/browser acceptance evidence.
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
        reads++;
        if (mode === 'unavailable') return Response.json({ error: 'unavailable' }, { status: 503 });
        return Response.json({
          methods: { password: true, passkey: false },
          viewer: {
            kind: 'signed-in',
            account_id: reads > 1 && mode === 'changed' ? 'story-b' : 'story-a',
            email: reads > 1 && mode === 'changed' ? 'second@example.test' : 'reader@example.test',
          },
          continuation: { href: '/security', requires_sign_in: false },
        });
      }
      if (input === '/signin') {
        if (mode === 'pending') return new Promise<Response>(() => {});
        throw new TypeError('Story: acknowledgement unavailable');
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

const switchAccount = async (canvas: HTMLElement) => {
  (await waitFor(() => button(canvas, m.auth_login_switch_account())))!.click();
  await waitFor(() => canvas.textContent?.includes(m.auth_login_switching()));
  if (button(canvas, m.auth_login_continue())) throw new Error('Old Continue must be retired');
};
const submit = async (canvas: HTMLElement) => {
  await switchAccount(canvas);
  fill(canvas.querySelector<HTMLInputElement>('#login-email')!, 'another@example.test');
  fill(canvas.querySelector<HTMLInputElement>('#login-password')!, 'story-password');
  await waitFor(() => canvas.querySelector<HTMLInputElement>('#login-password')?.value === 'story-password');
  button(canvas, m.auth_login_heading())!.click();
};
export const CurrentAccount = { render: () => <Page mode="current" /> };
export const Switching = {
  render: () => <Page mode="switching" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => switchAccount(canvasElement),
};
export const Pending = {
  render: () => <Page mode="pending" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_login_pending_password()));
    if (!button(canvasElement, m.auth_login_review_session())?.disabled)
      throw new Error('Review conflicts with pending sign-in');
  },
};
export const ChangedViewer = {
  render: () => <Page mode="changed" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    (await waitFor(() => button(canvasElement, m.auth_login_review_session())))!.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_login_viewer_changed()));
    if (canvasElement.textContent?.includes('reader@example.test'))
      throw new Error('Old private label survived review');
  },
};
export const Unavailable = { render: () => <Page mode="unavailable" /> };
export const UncertainReview = {
  render: () => <Page mode="uncertain" />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await submit(canvasElement);
    await waitFor(() => canvasElement.textContent?.includes(m.auth_login_uncertain()));
    button(canvasElement, m.auth_login_review_session())!.click();
    await waitFor(() => canvasElement.textContent?.includes(m.auth_login_reviewed()));
    if (!canvasElement.textContent?.includes(m.auth_login_uncertain()))
      throw new Error('Review cannot attribute success');
  },
};
