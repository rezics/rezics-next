import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { expect, userEvent, within, waitFor } from 'storybook/test';
import { DependencyUnavailablePage } from '../shell/dependency-recovery/page';
import { applyDependencyErrorComponents } from '../shell/dependency-recovery/route-error';
import { requirePrivatePageAccess } from '../session/guard';
import { sessionQueryKey } from '../session/browser-state';
import { m } from '../paraglide/messages.js';

const desktop1440 = { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' }, type: 'desktop' };
const meta = {
  title: 'Site Shell/Dependency recovery',
  id: 'pages-dependency-recovery',
  parameters: { layout: 'fullscreen', viewport: { options: { desktop1440 } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignInDiscoveryFailure: Story = {
  globals: { locale: 'en' },
  render: () => (
    <DependencyUnavailablePage
      locale="en"
      retryHref="/auth/sign-in?return_to=%2Fen%2Flibrary"
      returnHref="/en/library"
    />
  ),
};

export const ConsumedCallbackRecovery: Story = {
  globals: { locale: 'ja' },
  render: () => (
    <DependencyUnavailablePage
      locale="ja"
      retryHref="/auth/sign-in?return_to=%2Fja%2Flibrary"
      returnHref="/ja/library"
    />
  ),
};

function PrivateLoaderBoundary({ restored }: { restored: boolean }) {
  const router = useMemo(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionQueryKey, {
      state: 'signed-in',
      subject: 'story-reader',
      csrfToken: 'story-only-token',
    });
    const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
    let attempts = 0;
    const page = createRoute({
      getParentRoute: () => root,
      path: '/',
      beforeLoad: async (args) => ({ sessionAccess: await requirePrivatePageAccess(args) }),
      loader: async ({ context }) => {
        const attempt = ++attempts;
        if (context.sessionAccess.state !== 'signed-in') throw new Error('Admission did not complete');
        if (!restored || attempt === 1) {
          throw {
            status: 503,
            code: 'dependency_unavailable',
            retryable: true,
            problem: { status: 503, code: 'dependency_unavailable', retryable: true },
          };
        }
        return { title: 'Private page restored' };
      },
      errorComponent: (props) => (
        <div data-original-error="">{props.error instanceof Error ? props.error.message : 'Reader failed'}</div>
      ),
      component: function PrivatePage() {
        const data = page.useLoaderData() as { title: string };
        return <h1>{data.title}</h1>;
      },
    });
    const routeTree = root.addChildren([page]);
    applyDependencyErrorComponents(routeTree as never);
    return createRouter({
      routeTree,
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
  }, [restored]);

  return <RouterProvider router={router} />;
}

export const PrivateLoaderOutage: Story = {
  globals: { locale: 'en' },
  render: () => <PrivateLoaderBoundary restored={false} />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await page.findByRole('heading', { name: m.dependency_unavailable_heading() });
    await expect(page.getByRole('link', { name: m.status_home() })).toHaveAttribute('href', '/en');
    const retry = page.getByRole('button', { name: m.status_retry() });
    await expect(retry).toHaveClass(/min-h-11/);
    retry.focus();
    await expect(retry).toHaveFocus();
  },
};

export const RestoredDependency: Story = {
  globals: { locale: 'en' },
  render: () => <PrivateLoaderBoundary restored />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    const retry = await page.findByRole('button', { name: m.status_retry() });
    await expect(retry).toHaveClass(/min-h-11/);
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(page.getByRole('heading', { name: 'Private page restored' })).toBeVisible());
  },
};
