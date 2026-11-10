import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { readingFixture } from '../kernel/fake/settings-preferences-reading';
import { m } from '../paraglide/messages.js';
import { ReadingCard } from '../settings/reading-card';
import { ReadingNavigation, SettingsNavigationProvider } from '../settings/reading-navigation';
import { sessionQuery } from '../session/query';

const meta = {
  title: 'Account/Settings navigation',
  id: 'patterns-account-settings-navigation',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ChangeStoryViewer() {
  const client = useQueryClient();
  return (
    <button
      type="button"
      className="min-h-11"
      onClick={() =>
        client.setQueryData(sessionQuery.queryKey, {
          state: 'signed-in',
          subject: 'next-phone-viewer',
          csrfToken: 'next-phone-session',
        })
      }
    >
      Change viewer
    </button>
  );
}

function HomeDestination() {
  return (
    <main className="space-y-4 p-4">
      <h1>{m.nav_home()}</h1>
      <Link to="/settings">{m.settings_heading()}</Link>
    </main>
  );
}

function AlternateDestination() {
  return (
    <main className="space-y-4 p-4">
      <h1>{m.settings_account_heading()}</h1>
      <Link to="/settings">{m.settings_heading()}</Link>
    </main>
  );
}

function SettingsEditor() {
  const [fixture] = useState(() => readingFixture('lost'));
  const [version, setVersion] = useState(fixture.initial.version);
  return (
    <SettingsNavigationProvider>
      <main className="mx-auto flex min-w-0 max-w-2xl flex-col gap-4 p-4">
        <nav aria-label={m.settings_sections_label()} className="flex flex-wrap gap-4">
          <Link to="/" className="min-h-11 content-center underline">
            {m.nav_home()}
          </Link>
          <Link to="/accounts" className="min-h-11 content-center underline">
            {m.settings_account_heading()}
          </Link>
        </nav>
        <ChangeStoryViewer />
        <ReadingNavigation csrfToken="phone-story-session">
          <ReadingCard
            initial={fixture.initial}
            version={version}
            csrfToken="phone-story-session"
            onVersionChange={setVersion}
            io={fixture.io}
          />
        </ReadingNavigation>
      </main>
    </SettingsNavigationProvider>
  );
}

function createSettingsNavigationRouter() {
  const root = createRootRoute({ component: Outlet });
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsEditor });
  const home = createRoute({ getParentRoute: () => root, path: '/', component: HomeDestination });
  const alternate = createRoute({
    getParentRoute: () => root,
    path: '/accounts',
    component: AlternateDestination,
  });
  return createRouter({
    routeTree: root.addChildren([settings, home, alternate]),
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
}

type StoryRouter = ReturnType<typeof createSettingsNavigationRouter>;
type StoryRouterHost = HTMLDivElement & { storyRouter?: StoryRouter };

function SettingsNavigationPhoneExample() {
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'phone-story-viewer',
      csrfToken: 'phone-story-session',
    });
    return queryClient;
  });
  const router = useMemo(createSettingsNavigationRouter, []);
  const routerHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = routerHost.current as StoryRouterHost | null;
    if (!host) return;
    host.storyRouter = router;
    return () => {
      if (host.storyRouter === router) delete host.storyRouter;
    };
  }, [router]);
  return (
    <div ref={routerHost} data-settings-navigation-router>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </div>
  );
}

export const DraftDecisionPhoneRecovery: Story = {
  name: 'Draft decision and retired Reading recovery',
  tags: ['!dev'],
  globals: {},
  render: () => <SettingsNavigationPhoneExample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const router = await waitFor(() => {
      const current = canvasElement.querySelector<StoryRouterHost>('[data-settings-navigation-router]')?.storyRouter;
      if (!current) throw new Error('Settings navigation story router is not mounted.');
      return current;
    });
    const spoiler = await canvas.findByRole('radio', { name: m.settings_spoiler_1_title() });
    await waitFor(() => expect(spoiler).not.toBeDisabled());
    await userEvent.click(spoiler);
    await canvas.findByText(m.settings_reading_uncertain_title());
    const suitability = canvas.getByRole('switch', { name: m.settings_suitability_title() });
    await userEvent.click(suitability);

    const home = canvas.getByRole('link', { name: m.nav_home() });
    await userEvent.click(home);
    const dialogElement = await page.findByRole('alertdialog');
    const dialog = within(dialogElement);
    const stay = dialog.getByRole('button', { name: m.settings_profile_stay() });
    const leave = dialog.getByRole('button', { name: m.settings_profile_leave() });
    await waitFor(() => expect(stay).toHaveFocus());

    const dialogBounds = dialogElement.getBoundingClientRect();
    await expect(dialogBounds.left).toBeGreaterThanOrEqual(0);
    await expect(dialogBounds.right).toBeLessThanOrEqual(window.innerWidth);
    await expect(dialogBounds.width).toBeLessThanOrEqual(window.innerWidth - 32);
    await expect(dialogBounds.height).toBeLessThanOrEqual(window.innerHeight - 16);
    await expect(window.getComputedStyle(dialogElement).overflowY).toBe('auto');
    for (const action of [stay, leave]) {
      const bounds = action.getBoundingClientRect();
      await expect(bounds.height).toBeGreaterThanOrEqual(44);
      await expect(bounds.left).toBeGreaterThanOrEqual(dialogBounds.left);
      await expect(bounds.right).toBeLessThanOrEqual(dialogBounds.right);
      await expect(window.getComputedStyle(action).whiteSpace).toBe('normal');
      await expect(action.scrollWidth).toBeLessThanOrEqual(action.clientWidth);
    }

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('alertdialog')).toBeNull());
    await expect(home).toHaveFocus();
    await expect(spoiler).toBeChecked();
    await expect(suitability).toBeChecked();

    await userEvent.click(home);
    const reopenedDialog = within(await page.findByRole('alertdialog'));
    await waitFor(() => expect(reopenedDialog.getByRole('button', { name: m.settings_profile_stay() })).toHaveFocus());
    // The Accounts link is inert behind the modal; this is a competing programmatic request, not user input.
    const competingNavigation = router.navigate({ to: '/accounts' }).then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await expect(await page.findAllByRole('alertdialog')).toHaveLength(1);
    await userEvent.click(reopenedDialog.getByRole('button', { name: m.settings_profile_leave() }));
    const competingResult = await competingNavigation;
    await expect(competingResult.status).toBe('resolved');
    await canvas.findByRole('heading', { name: m.nav_home() });
    await expect(canvas.queryByRole('heading', { name: m.settings_account_heading() })).toBeNull();
    await expect(page.queryByRole('alertdialog')).toBeNull();

    await userEvent.click(canvas.getByRole('link', { name: m.settings_heading() }));
    await expect(await canvas.findByRole('radio', { name: m.settings_spoiler_0_title() })).toBeChecked();
    const nextDraft = canvas.getByRole('radio', { name: m.settings_spoiler_1_title() });
    await userEvent.click(nextDraft);
    await canvas.findByText(m.settings_reading_uncertain_title());
    await userEvent.click(canvas.getByRole('button', { name: 'Change viewer' }));
    await canvas.findByText(m.settings_reading_session_changed());
    await expect(canvas.queryByRole('radio')).toBeNull();
    await expect(canvas.queryByRole('switch')).toBeNull();

    const reload = canvas.getByRole('button', { name: m.settings_reload() });
    const reloadBounds = reload.getBoundingClientRect();
    await expect(reloadBounds.height).toBeGreaterThanOrEqual(44);
    await expect(reloadBounds.width).toBeLessThanOrEqual(window.innerWidth - 32);
    await expect(reloadBounds.left).toBeGreaterThanOrEqual(0);
    await expect(reloadBounds.right).toBeLessThanOrEqual(window.innerWidth);
    await expect(window.getComputedStyle(reload).whiteSpace).toBe('normal');
    await expect(reload.scrollWidth).toBeLessThanOrEqual(reload.clientWidth);

    await userEvent.click(canvas.getByRole('link', { name: m.nav_home() }));
    await canvas.findByRole('heading', { name: m.nav_home() });
    await expect(page.queryByRole('alertdialog')).toBeNull();
    await userEvent.click(canvas.getByRole('link', { name: m.settings_heading() }));
    await canvas.findByText(m.settings_reading_session_changed());
    await expect(canvas.queryByRole('radio')).toBeNull();
    await expect(canvas.queryByRole('switch')).toBeNull();
  },
};
