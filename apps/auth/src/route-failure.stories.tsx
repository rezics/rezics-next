import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AuthPage, AuthShell } from './frame';
import { RouteFailureError, RouteMissing, RouteRecoveryProvider } from './route-failure-view';

export default {
  title: 'Pages/Auth/Route recovery',
  parameters: {
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '1000px' } },
      },
    },
  },
};

type Journey = 'ready' | 'reading' | 'failed' | 'missing' | 'returned' | 'recovered';

function CurrentPage() {
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    field.current?.focus();
  }, []);
  return (
    <AuthPage heading="Current page">
      <form onSubmit={(event) => event.preventDefault()}>
        <label>
          Email
          <input ref={field} type="email" autoComplete="email" />
        </label>
        <button type="submit">Continue</button>
      </form>
    </AuthPage>
  );
}

function JourneyPage({ journey, dark }: { journey: Journey; dark: boolean }) {
  const [router] = useState(() => {
    let reads = 0;
    const root = createRootRoute({
      component: () => <Outlet />,
      shellComponent: ({ children }) => (
        <AuthShell>
          <RouteRecoveryProvider>{children}</RouteRecoveryProvider>
        </AuthShell>
      ),
      notFoundComponent: RouteMissing,
    });
    const page = createRoute({
      getParentRoute: () => root,
      path: '/read',
      loader: async () => {
        reads += 1;
        if (reads === 1 || journey === 'failed') throw new Error('Story read unavailable');
        if (journey !== 'recovered') await new Promise<void>(() => {});
        return null;
      },
      component: CurrentPage,
    });
    return createRouter({
      history: createMemoryHistory({ initialEntries: [journey === 'missing' ? '/missing' : '/read'] }),
      routeTree: root.addChildren([page]),
      defaultErrorComponent: RouteFailureError,
    });
  });
  useEffect(() => () => router.history.destroy(), [router]);
  return (
    <div className={dark ? 'dark' : ''}>
      <RouterProvider router={router} />
    </div>
  );
}

// Exercise the mounted provider, not a second presentation-state controller.
async function activate(canvas: HTMLElement) {
  const button = () => canvas.querySelector<HTMLButtonElement>('.auth-route-failure button');
  if (!button())
    await new Promise<void>((resolve, reject) => {
      const observer = new MutationObserver(() => {
        if (button()) {
          observer.disconnect();
          clearTimeout(timeout);
          resolve();
        }
      });
      observer.observe(canvas, { subtree: true, childList: true });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Missing recovery view'));
      }, 3000);
    });
  button()!.click();
}

function story(journey: Journey, viewport: 'phone390' | 'desktop1280', dark = false) {
  return {
    render: () => <JourneyPage journey={journey} dark={dark} />,
    globals: { viewport: { value: viewport, isRotated: false } },
    play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
      if (journey === 'ready' || journey === 'missing') return;
      await activate(canvasElement);
      if (journey === 'returned') {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      }
    },
  };
}

export const ReadyPhone = story('ready', 'phone390');
export const ReadyPhoneDark = story('ready', 'phone390', true);
export const ReadyDesktop = story('ready', 'desktop1280');
export const ReadyDesktopDark = story('ready', 'desktop1280', true);
export const ReadingPhone = story('reading', 'phone390');
export const ReadingPhoneDark = story('reading', 'phone390', true);
export const ReadingDesktop = story('reading', 'desktop1280');
export const ReadingDesktopDark = story('reading', 'desktop1280', true);
export const FailedPhone = story('failed', 'phone390');
export const FailedPhoneDark = story('failed', 'phone390', true);
export const FailedDesktop = story('failed', 'desktop1280');
export const FailedDesktopDark = story('failed', 'desktop1280', true);
export const MissingPhone = story('missing', 'phone390');
export const MissingPhoneDark = story('missing', 'phone390', true);
export const MissingDesktop = story('missing', 'desktop1280');
export const MissingDesktopDark = story('missing', 'desktop1280', true);
export const ReturnedPhone = story('returned', 'phone390');
export const ReturnedPhoneDark = story('returned', 'phone390', true);
export const ReturnedDesktop = story('returned', 'desktop1280');
export const ReturnedDesktopDark = story('returned', 'desktop1280', true);
export const RecoveredPhone = story('recovered', 'phone390');
export const RecoveredPhoneDark = story('recovered', 'phone390', true);
export const RecoveredDesktop = story('recovered', 'desktop1280');
export const RecoveredDesktopDark = story('recovered', 'desktop1280', true);
