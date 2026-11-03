import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/app-shell';
import { SideNav } from '../shell/side-nav';
import { NotificationsLink, ShellTopActions, TopBar } from '../shell/top-bar';
import { UnreadBadgeView } from '../inbox/unread-badge';
import { m } from '../paraglide/messages.js';
import { PatternStory, pageReady } from './page';

const meta = {
  title: 'Patterns/App Shell',
  globals: { viewport: { value: 'desktop' } },
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function ShellPreview({
  visitor = 'Signed In',
  count = false,
}: {
  visitor?: 'Signed In' | 'Signed Out';
  count?: boolean;
}) {
  return (
    <PatternStory visitor={visitor} path="/library">
      <AppShell
        communities={
          visitor === 'Signed In' ? (
            <SideNav
              pathname="/library"
              items={[
                { id: 'reading', kind: 'realm', title: 'Reading together', path: '/realms/reading' },
                { id: 'quiet', kind: 'space', title: 'A quiet space', path: '/spaces/quiet' },
              ]}
            />
          ) : null
        }
        notifications={
          count ? (
            <NotificationsLink
              pathname="/library"
              badge={<UnreadBadgeView data={{ signedIn: true, state: 'ready', count: 23, capped: false }} />}
            />
          ) : undefined
        }
      >
        <h1 className="text-2xl font-semibold">{m.nav_library()}</h1>
        <p className="mt-3 text-muted-foreground">Your reading, collections and communities in one place.</p>
      </AppShell>
    </PatternStory>
  );
}

export const Desktop: Story = {
  globals: { viewport: { value: 'desktop' } },
  render: () => <ShellPreview />,
  play: pageReady,
};
export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  render: () => <ShellPreview />,
  play: pageReady,
};
export const SignedIn: Story = {
  render: () => <ShellPreview />,
  play: async (context) => {
    await pageReady(context);
    await userEvent.click(await within(context.canvasElement).findByRole('button', { name: m.account_menu() }));
    const menu = within(await within(document.body).findByRole('dialog', { name: m.account_menu() }));
    await expect(await menu.findByRole('button', { name: m.shell_theme() })).toBeVisible();
    await expect(await menu.findByRole('button', { name: new RegExp(m.shell_language()) })).toBeVisible();
  },
};
export const SignedOut: Story = {
  render: () => <ShellPreview visitor="Signed Out" />,
  play: async (context) => {
    await pageReady(context);
    await expect(await within(context.canvasElement).findByRole('link', { name: m.account_sign_in() })).toBeVisible();
  },
};
export const NotificationCount: Story = {
  render: () => <ShellPreview count />,
  play: async (context) => {
    await pageReady(context);
    await expect(
      await within(context.canvasElement).findByLabelText(m.inbox_unread_count({ count: '23' })),
    ).toBeVisible();
  },
};

export const FoldedCommunities: Story = {
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const heading = await canvas.findByRole('button', {
      name: `${m.library_following_heading()} · ${m.realms_heading()}`,
    });
    await expect(heading).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(heading);
    await expect(heading).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.queryByRole('link', { name: 'Reading together' })).toBeNull();
    await userEvent.click(heading);
    await expect(await canvas.findByRole('link', { name: 'Reading together' })).toBeVisible();
  },
};

export const PhoneCreate: Story = {
  globals: { viewport: { value: 'phone' } },
  play: async (context) => {
    await pageReady(context);
    const nav = within(await within(context.canvasElement).findByRole('navigation', { name: m.shell_phone_tabs() }));
    await userEvent.click(nav.getByRole('button', { name: m.shell_create() }));
    await expect(await within(document.body).findByRole('dialog', { name: m.shell_create() })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(nav.getByRole('button', { name: m.shell_create() })).toHaveFocus();
  },
};

function HeaderState({ session }: { session: 'unknown' | 'unavailable' }) {
  return (
    <PatternStory visitor="Signed Out" path="/">
      <TopBar
        navigation={null}
        logo={<a href="/en">REZICS</a>}
        search={<input aria-label="Search" className="w-full" />}
        actions={<ShellTopActions session={session} pathname="/" returnTo="/en" account={null} />}
      />
    </PatternStory>
  );
}
export const RestoringHeader: Story = { render: () => <HeaderState session="unknown" /> };
export const UnavailableHeader: Story = {
  render: () => <HeaderState session="unavailable" />,
  globals: { viewport: { value: 'phone' } },
};
