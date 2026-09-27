import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AccountMenu } from '../auth/account-menu.tsx';
import { messages as auth } from '../auth/messages.ts';
import type { Session } from '../auth/session.ts';
import { SignInLink } from '../auth/sign-in-link.tsx';
import { AppShell } from './app-shell.tsx';
import { messages } from './messages.ts';
import { NotificationsLink } from './notifications-link.tsx';
import { PageContainer, PageHeader } from './page.tsx';

const ada = { iri: 'https://rezics.com/id/57c86232-6db4-4b0d-aa56-e4ad584d07b4', label: 'Ada Lovelace',
  handle: 'ada', kind: 'person', path: 'direct-principal' } as const;
const signedIn: Session = { user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.test', image: null },
  agent: { status: 'selected', agent: ada }, agents: [ada], expiresAt: '2026-10-27T00:00:00.000Z' };

const society = { iri: 'https://rezics.com/id/07309b3b-c8f6-4211-bdb3-9aa486c1e4d5',
  label: 'Riverside Historical Society Translation Collective', handle: null,
  kind: 'organization', path: 'represented-agent' } as const;
const longNames: Session = { ...signedIn,
  user: { id: 'u2', name: 'Maximiliana Theodora Wilhelmina von Aschenbrenner-Kowalczyk',
    email: 'maximiliana.theodora.von.aschenbrenner-kowalczyk@example-institution.test', image: null },
  agent: { status: 'selected', agent: society }, agents: [society] };

function Placeholder() {
  return <PageContainer className="grid gap-6">
    <PageHeader title="Page title" description="Routes render their content here, inside the shell." />
    <div className="h-[120vh] rounded-2xl border border-border/80 border-dashed" />
  </PageContainer>;
}

const meta = {
  title: 'Shell/App shell', component: AppShell,
  args: { locale: 'en', messages: messages.en, theme: 'light', navCollapsed: false,
    account: <SignInLink label={auth.en.signIn} />, children: <Placeholder /> },
  globals: { viewport: { value: 'desktop' } },
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const search = canvas.getByRole('searchbox', { name: 'Search works' });
    await expect(canvas.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main-content');
    await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/start?next=%2F');
    await userEvent.keyboard('/');
    await expect(search).toHaveFocus();
    await userEvent.click(canvas.getByRole('heading', { name: 'Page title' }));
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect(search).toHaveFocus();
    const navigation = canvas.getByRole('navigation', { name: 'Main navigation' });
    await expect(within(navigation).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    await expect(canvas.getByRole('button', { name: 'Display mode' })).toBeVisible();
  },
};

export const SignedIn: Story = {
  args: { signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth.en} />, notifications: <NotificationsLink /> },
  parameters: { route: { pathname: '/en/studio' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Notifications' })).toHaveAttribute('href', '/inbox');
    await userEvent.click(canvas.getByRole('button', { name: 'Account menu' }));
    const menu = within(await within(document.body).findByRole('menu'));
    await waitFor(() => expect(menu.getByRole('menuitem', { name: 'Switch Agent' })).toBeVisible());
    await expect(menu.getByRole('group', { name: 'Acting as' })).toHaveTextContent('Ada Lovelace');
    await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};

export const LongNames: Story = {
  args: { signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={longNames} messages={auth.en} />, notifications: <NotificationsLink /> },
  parameters: { route: { pathname: '/en/search', search: 'q=A+very+long+search+phrase+about+rivers+and+cities+across+centuries' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('searchbox', { name: 'Search works' }))
      .toHaveValue('A very long search phrase about rivers and cities across centuries');
    await userEvent.click(canvas.getByRole('button', { name: 'Account menu' }));
    const menu = within(await within(document.body).findByRole('menu'));
    await waitFor(() => expect(menu.getByRole('group', { name: 'Acting as' }))
      .toHaveTextContent('Riverside Historical Society Translation Collective'));
    await userEvent.keyboard('{Escape}');
  },
};

export const CollapsedNavigation: Story = {
  parameters: { navCollapsed: true },
  args: { navCollapsed: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole('button', { name: 'Expand navigation' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(canvas.getByRole('combobox', { name: 'Language' })).toBeVisible();
    await userEvent.click(toggle);
    await expect(canvas.getByRole('button', { name: 'Collapse navigation' })).toHaveAttribute('aria-expanded', 'true');
    await expect(canvas.queryByText('Preferences')).toBeNull();
  },
};

export const Dark: Story = {
  args: { theme: 'dark', signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth.en} />, notifications: <NotificationsLink /> },
  globals: { theme: 'dark' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Account menu' }));
    const menu = within(await within(document.body).findByRole('menu'));
    await waitFor(() => expect(menu.getByRole('menuitem', { name: 'Display mode' })).toBeVisible());
    await userEvent.click(menu.getByRole('menuitem', { name: 'Display mode' }));
    await waitFor(() => expect(within(document.body).getByRole('menuitemradio', { name: 'Dark' }))
      .toHaveAttribute('aria-checked', 'true'));
  },
};

export const ThemeChoice: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Display mode' });
    await userEvent.click(trigger);
    await userEvent.click(within(document.body).getByRole('menuitemradio', { name: 'Dark' }));
    await expect(document.documentElement).toHaveClass('dark');
    await expect(document.cookie).toContain('rezics_theme=dark');
    await userEvent.click(trigger);
    await userEvent.click(within(document.body).getByRole('menuitemradio', { name: 'Match system' }));
    await expect(document.documentElement).not.toHaveClass('dark');
    await expect(document.documentElement).not.toHaveClass('light');
    await userEvent.click(trigger);
    await userEvent.click(within(document.body).getByRole('menuitemradio', { name: 'Light' }));
    await expect(document.documentElement).toHaveClass('light');
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'], signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth['zh-Hans']} />,
    notifications: <NotificationsLink /> },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '账户菜单' }));
    await waitFor(() => expect(within(document.body).getByRole('menuitem', { name: '语言' })).toBeVisible());
    await userEvent.click(within(document.body).getByRole('menuitem', { name: '语言' }));
    await waitFor(() => expect(within(document.body).getByRole('menuitemradio', { name: '简体中文' }))
      .toHaveAttribute('aria-checked', 'true'));
    await expect(canvas.getByRole('searchbox', { name: '搜索作品' })).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/en/discover' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const bottom = canvas.getByRole('navigation', { name: 'Main navigation' });
    await expect(within(bottom).getAllByRole('link')).toHaveLength(5);
    await expect(within(bottom).getByRole('link', { name: 'Discover' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('combobox', { name: 'Language' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Open navigation' }));
    const drawer = within(await within(document.body).findByRole('dialog', { name: 'Menu' }));
    await expect(drawer.queryByText('Preferences')).toBeNull();
    await userEvent.click(drawer.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PhoneSignedInChinese: Story = {
  args: { locale: 'zh-Hans', messages: messages['zh-Hans'], signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={longNames} messages={auth['zh-Hans']} />,
    notifications: <NotificationsLink /> },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: '账户菜单' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '账户菜单' }));
    const sheet = await within(document.body).findByRole('dialog', { name: '账户菜单' });
    await waitFor(() => expect(within(sheet).getByRole('group', { name: '语言' })).toBeVisible());
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PhoneDark: Story = {
  args: { theme: 'dark' },
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/en/studio' } },
};
