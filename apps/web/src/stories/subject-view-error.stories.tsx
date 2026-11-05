import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useMemo } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { deLocalizeUrl, getLocale, localizeUrl } from '../paraglide/runtime.js';
import { SubjectViewError } from '../subject/view-error';

const entry =
  '/subjects/example/%E6%9C%AC%20%26%20book/relations?cursor=refused%2Bcursor&realm=reading&node=related&context=review%2Fnotes#selection';

function RecoveryExample({
  errorMessage,
  onReset,
  onRead,
}: {
  errorMessage: string;
  onReset: () => void;
  onRead: (location: { pathname: string; searchStr: string; hash: string }) => void;
}) {
  const locale = getLocale();
  const router = useMemo(() => {
    const root = createRootRoute();
    const view = createRoute({
      getParentRoute: () => root,
      path: '/subjects/$id/$slug/$view',
      loader: ({ location }) => {
        onRead(location);
        throw new Error(errorMessage);
      },
      errorComponent: (props) => (
        <SubjectViewError
          {...props}
          reset={() => {
            onReset();
            props.reset();
          }}
        />
      ),
    });
    const url = localizeUrl(new URL(entry, 'https://rezics.test'), { locale });
    return createRouter({
      routeTree: root.addChildren([view]),
      history: createMemoryHistory({ initialEntries: [`${url.pathname}${url.search}${url.hash}`] }),
      rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    });
  }, [errorMessage, locale, onRead, onReset]);
  return <RouterProvider router={router} />;
}

const meta = {
  title: 'Patterns/Subjects/View error',
  component: RecoveryExample,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Shared recovery presentation in an isolated router whose loader always fails. Keyboard plays exercise the real reset callback and restart navigation; they establish no native read, permission or successful source outcome. Use the shared locale, theme and 390/1280 viewport globals.',
      },
    },
  },
  args: { errorMessage: 'unavailable', onReset: fn(), onRead: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', {
      level: 1,
      name: args.errorMessage === 'dependency_unavailable' ? m.subject_view_changed() : m.subject_view_unavailable(),
    });
    const retry = canvas.getByRole('button', { name: m.subject_view_retry() });
    const restart = canvas.getByRole('link', { name: m.subject_view_restart() });
    const destination = localizeUrl(new URL(entry, 'https://rezics.test'));
    destination.searchParams.delete('cursor');
    await expect(restart).toHaveAttribute('href', `${destination.pathname}${destination.search}${destination.hash}`);
    for (const target of [retry, restart]) {
      await expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(target.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    }
    const retryBox = retry.getBoundingClientRect();
    const restartBox = restart.getBoundingClientRect();
    await expect(restartBox.left >= retryBox.right + 12 || restartBox.top >= retryBox.bottom + 12).toBe(true);
    for (let step = 0; step < 10 && document.activeElement !== retry; step += 1) await userEvent.tab();
    await expect(retry).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onReset).toHaveBeenCalledTimes(1);
    await expect(args.onRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchStr: new URL(entry, 'https://rezics.test').search }),
    );
    const restartAfterReset = await canvas.findByRole('link', { name: m.subject_view_restart() });
    for (let step = 0; step < 10 && document.activeElement !== restartAfterReset; step += 1) await userEvent.tab();
    await expect(restartAfterReset).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const internal = deLocalizeUrl(destination);
    await waitFor(() =>
      expect(args.onRead).toHaveBeenLastCalledWith(
        expect.objectContaining({
          pathname: internal.pathname,
          searchStr: internal.search,
          hash: internal.hash.slice(1),
        }),
      ),
    );
  },
} satisfies Meta<typeof RecoveryExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unavailable: Story = {};
export const DependencyUnavailable: Story = { args: { errorMessage: 'dependency_unavailable' } };
