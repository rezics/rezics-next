import { useLayoutEffect, useMemo, useState } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { AuthShell } from '../../frame';
import { Route } from '../../routes/recovery';
import { m } from '../../paraglide/messages.js';
import { authLocale, reviewParameters, button, fill, waitFor } from '../accounts-operations/story';
import '../../styles.css';

export default {
  title: 'Pages/Account/Recovery return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

type Mode = 'start-acknowledged' | 'start-unknown' | 'complete-unknown' | 'unavailable' | 'pending';
// Real route with bounded presentation fixtures. These are not native acceptance results.
function Page({ mode }: { mode: Mode }) {
  const [installed, setInstalled] = useState(false);
  const router = useMemo(() => {
    const root = createRootRoute({
      component: () => (
        <AuthShell>
          <Outlet />
        </AuthShell>
      ),
    });
    const recovery = createRoute({
      getParentRoute: () => root,
      path: '/recovery',
      component: Route.options.component!,
    });
    return createRouter({
      history: createMemoryHistory({ initialEntries: ['/recovery'] }),
      routeTree: root.addChildren([recovery]),
    });
  }, []);
  useLayoutEffect(() => {
    const originalFetch = globalThis.fetch;
    const originalUrl = window.location.href;
    if (mode !== 'start-acknowledged' && mode !== 'start-unknown')
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${window.location.search}#account_id=story&token=story-token`,
      );
    let reads = 0;
    globalThis.fetch = (async (input, init) => {
      if (input === '/recovery/page') {
        reads++;
        if (reads > 1 && mode === 'unavailable') return new Response('', { status: 503 });
        if (reads > 1 && mode === 'pending') return new Promise<Response>(() => {});
        const stage = JSON.parse(String(init?.body)).stage;
        return Response.json({
          stage,
          viewer: { kind: 'signed-out' },
          methods: { email: true, password: true, passkey: false },
          requirements: { email_max_length: 254, password_min_length: 8, password_max_length: 128 },
          continuation: 'sign-in',
          actions: { start: stage === 'start', complete: stage === 'complete', authenticate: false },
        });
      }
      if (input === '/recovery/start' && mode === 'start-acknowledged') return Response.json({ success: true });
      if (input === '/recovery/start' || input === '/recovery/complete')
        throw new TypeError('Story: acknowledgement unavailable');
      return originalFetch(input, init);
    }) as typeof fetch;
    const restore = () => router.history.replace('/recovery');
    window.addEventListener('recovery-story-return', restore);
    setInstalled(true);
    return () => {
      globalThis.fetch = originalFetch;
      window.removeEventListener('recovery-story-return', restore);
      window.history.replaceState(window.history.state, '', originalUrl);
    };
  }, [mode, router]);
  return installed ? <RouterProvider router={router} /> : null;
}
const returned = async (canvas: HTMLElement) => {
  const input = await waitFor(() => canvas.querySelector<HTMLInputElement>('input'));
  fill(input!, input!.name === 'email' ? 'reader@example.test' : 'story private password');
  await waitFor(() => input!.value.length > 0);
  button(canvas, input!.name === 'email' ? m.auth_recovery_start_submit() : m.auth_recovery_complete_submit())!.click();
  await waitFor(
    () => canvas.textContent?.includes(m.auth_recovery_start_success()) || canvas.querySelector('[role="alert"]'),
  );
  window.dispatchEvent(new Event('recovery-story-return'));
  await waitFor(() => canvas.textContent?.includes(m.auth_recovery_return_heading()));
  if (canvas.querySelector('input')) throw new Error('Returned history must not restore credentials');
};
const story = (mode: Mode) => ({
  render: () => <Page mode={mode} />,
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => returned(canvasElement),
});
export const StartAcknowledged = story('start-acknowledged');
export const StartUnknown = story('start-unknown');
export const CompletionUnknown = story('complete-unknown');
export const AdviceUnavailable = story('unavailable');
export const AdvicePending = story('pending');
