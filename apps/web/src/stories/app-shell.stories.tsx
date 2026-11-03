import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/app-shell';
import { SideNav } from '../shell/side-nav';
import { NotificationsLink } from '../shell/top-bar';
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
