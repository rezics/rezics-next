import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AccountMenu } from '../auth/account-menu.tsx';
import { messages as auth } from '../auth/messages.ts';
import type { Session } from '../auth/session.ts';
import { SignInLink } from '../auth/sign-in-link.tsx';
import { AppShell } from './app-shell.tsx';
import type { CommunityNavigation } from './communities.ts';
import { CommunityNav } from './community-nav.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { NotificationsLink } from './notifications-link.tsx';
import { PageContainer, PageHeader } from './page.tsx';
import { setUnread } from './unread.ts';
import { spaceHref } from '../address/path.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { withZoneAddress } from './communities-relationships.ts';

const zhHansShellMessages = { ...messages, ...zhHans };

const ada = { iri: 'https://rezics.com/id/57c86232-6db4-4b0d-aa56-e4ad584d07b4', label: 'Ada Lovelace',
  handle: 'ada', kind: 'person', path: 'direct-principal' } as const;
const signedIn: Session = { user: { id: 'u1' },
  agent: { status: 'selected', agent: ada }, agents: [ada], expiresAt: '2026-10-27T00:00:00.000Z' };

const society = { iri: 'https://rezics.com/id/07309b3b-c8f6-4211-bdb3-9aa486c1e4d5',
  label: 'Riverside Historical Society Translation Collective', handle: null,
  kind: 'organization', path: 'represented-agent' } as const;
const longNames: Session = { ...signedIn,
  user: { id: 'u2' },
  agent: { status: 'selected', agent: society }, agents: [society] };

const realm = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-aaaa-4a6f-8c2d-3e7b5c1a9f40`;
const communities: CommunityNavigation = { signedIn: true, avatarQuery: '',
  followed: { zones: [], realms: [
    { id: realm(1), kind: 'realm', name: '中文网络小说', language: 'zh-Hans', direction: 'ltr',
      icon: { kind: 'fallback', key: 'fiction' }, href: spaceHref(realm(1), 'community'), activity: 'new' },
    { id: realm(2), kind: 'realm', name: 'Classic Literature', language: 'en', icon: { kind: 'fallback', key: 'classics' },
      href: spaceHref(realm(2), 'community'), activity: 'none' },
    // An official Zone's Realm, followed directly: it opens at the Zone's address and is not listed twice.
    { id: realm(4), kind: 'realm', name: 'Books', language: 'en', icon: { kind: 'fallback', key: 'b' },
      href: spaceHref('books', 'community'), activity: 'none' },
  ] },
  official: [{ id: realm(3), kind: 'zone', realm: realm(13), name: 'Fiction', language: 'en',
    icon: { kind: 'fallback', key: 'f' }, href: spaceHref('fiction', 'site'), activity: 'unknown' },
  { id: realm(5), kind: 'zone', realm: realm(4), name: 'Books', language: 'en', icon: { kind: 'fallback', key: 'b' },
    href: spaceHref('books', 'site'), activity: 'unknown' }],
  moderated: [{ realm: realm(2), open: 8, more: false, href: `/manage/r/${realm(2).slice(-36)}` }] };

function Placeholder() {
  return <PageContainer className="grid gap-6">
    <PageHeader title="Page title" description="Routes render their content here, inside the shell." />
    <div className="h-[120vh] rounded-2xl border border-border/80 border-dashed" />
  </PageContainer>;
}

/**
 * A sheet stays mounted until `animationend`. Closing during the entrance
 * animation misses that event, so the dialog never leaves. Wait until nothing is running.
 */
async function whenSettled(name: string) {
  await waitFor(async () => {
    const dialog = within(document.body).getByRole('dialog', { name });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const running = dialog.getAnimations({ subtree: true }).some(animation => animation.playState === 'running');
    await expect(running).toBe(false);
  }, { timeout: 5000 });
}

const meta = {
  title: 'Shell/App shell', component: AppShell,
  args: { locale: 'en', messages, theme: 'light', navCollapsed: false,
    account: <SignInLink label={auth.en.signIn} />, children: <Placeholder /> },
  globals: { viewport: { value: 'desktop' } },
  // The unread count is shared across the page, so each story starts without one.
  beforeEach() { setUnread(null); },
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const search = canvas.getByRole('searchbox', { name: 'Search everything' });
    await expect(canvas.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main-content');
    await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/start?next=%2F');
    await userEvent.keyboard('/');
    await expect(search).toHaveFocus();
    await userEvent.click(canvas.getByRole('heading', { name: 'Page title' }));
    await userEvent.keyboard('{Control>}k{/Control}');
    await expect(search).toHaveFocus();
    const navigation = canvas.getByRole('navigation', { name: 'Main navigation' });
    await expect(within(navigation).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await expect(canvas.getByRole('combobox', { name: 'Language' })).toHaveTextContent('English');
    await expect(canvas.getByRole('button', { name: 'Display mode' })).toBeVisible();
  },
};

export const OfficialSites: Story = {
  args: { communities: <CommunityNav data={{ ...communities, signedIn: false, followed: null,
    moderated: [] }} /> },
  parameters: { route: { pathname: localizedPath(spaceHref('fiction', 'site'), 'en') } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const sites = within(canvas.getByRole('region', { name: 'Official Zones' }));
    await expect(await sites.findByRole('link', { name: 'Fiction' })).toHaveAttribute('href', localizedPath(spaceHref('fiction', 'site'), 'en'));
    await expect(sites.getByRole('link', { name: 'Fiction' })).toHaveAttribute('aria-current', 'page');
    await expect(sites.getByRole('link', { name: 'Books' })).toHaveAttribute('href', localizedPath(spaceHref('books', 'site'), 'en'));
    if ('__vitest_browser__' in globalThis) {
      const { page } = await import('vitest/browser');
      await document.fonts.ready;
      await page.screenshot({ path: '../../../../.temp/g-989/official-sites-desktop.png' });
      await page.viewport(390, 844);
      await userEvent.click(canvas.getByRole('button', { name: 'Open navigation' }));
      const mobile = within(await within(document.body).findByRole('dialog', { name: 'Menu' }));
      await expect(await mobile.findByRole('link', { name: 'Fiction' })).toHaveAttribute('href', localizedPath(spaceHref('fiction', 'site'), 'en'));
      await page.screenshot({ path: '../../../../.temp/g-989/official-sites-phone.png' });
      await whenSettled('Menu');
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(within(document.body).queryByRole('dialog', { name: 'Menu' })).toBeNull());
      await page.viewport(1280, 860);
    }
  },
};

export const SignedIn: Story = {
  args: { signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth.en} />, notifications: <NotificationsLink /> },
  parameters: { route: { pathname: '/en/studio' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(within(canvasElement.querySelector('header')!).getByRole('link', { name: 'Notifications' }))
      .toHaveAttribute('href', '/en/notifications');
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
  parameters: { route: { pathname: '/en/discover', search: 'q=A+very+long+search+phrase+about+rivers+and+cities+across+centuries' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('searchbox', { name: 'Search everything' }))
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
    await waitFor(() => expect(menu.getByRole('menuitem', { name: 'Appearance: Dark' })).toBeVisible());
    await userEvent.click(menu.getByRole('menuitem', { name: 'Appearance: Dark' }));
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
  args: { locale: 'zh-Hans', messages: zhHansShellMessages, signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth['zh-Hans']} />,
    notifications: <NotificationsLink /> },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '账户菜单' }));
    await waitFor(() => expect(within(document.body).getByRole('menuitem', { name: '语言: 简体中文' })).toBeVisible());
    await userEvent.click(within(document.body).getByRole('menuitem', { name: '语言: 简体中文' }));
    await waitFor(() => expect(within(document.body).getByRole('menuitemradio', { name: '简体中文' }))
      .toHaveAttribute('aria-checked', 'true'));
    await expect(canvas.getByRole('searchbox', { name: '搜索所有内容' })).toBeVisible();
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
    const drawer = within(await within(document.body).findByRole('dialog', { name: 'Menu' }, { timeout: 5000 }));
    await expect(drawer.queryByText('Preferences')).toBeNull();
    await userEvent.click(drawer.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull());
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PhoneSignedInChinese: Story = {
  args: { locale: 'zh-Hans', messages: zhHansShellMessages, signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={longNames} messages={auth['zh-Hans']} />,
    notifications: <NotificationsLink /> },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: '账户菜单' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '账户菜单' }));
    const sheet = await within(document.body).findByRole('dialog', { name: '账户菜单' });
    const currentLanguage = await within(sheet).findByRole('button', { name: '语言: 简体中文' });
    await waitFor(() => expect(currentLanguage).toBeVisible());
    await userEvent.click(currentLanguage);
    const language = await within(document.body).findByRole('dialog', { name: '语言' });
    await waitFor(() => expect(within(language).getByRole('radiogroup', { name: '语言' })).toBeVisible());
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const PhoneDark: Story = {
  args: { theme: 'dark' },
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/en/studio' } },
};

/**
 * Signed in: relationships come before moderation; Official Zones are hidden
 * once the reader follows anything; the bell and the navigation
 * carry the unread count.
 */
export const Communities: Story = {
  args: { signedIn: true, communities: <CommunityNav data={communities} />, notifications: <NotificationsLink />,
    account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth.en} /> },
  parameters: { route: { pathname: '/en' } },
  beforeEach() { setUnread({ count: 3, overflow: false }); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole('navigation', { name: 'Main navigation' });
    const realms = within(nav).getByRole('region', { name: 'Communities and sites' });
    await expect(await within(realms).findByRole('link', { name: /^中文网络小说\s*, new posts$/ }))
      .toHaveAttribute('href', localizedPath(spaceHref(realm(1), 'community'), 'en'));
    await expect(within(realms).getByText('中文网络小说')).toHaveAttribute('lang', 'zh-Hans');
    await expect(within(realms).getByRole('link', { name: 'Classic Literature' })).toBeVisible();
    await expect(within(nav).queryByRole('region', { name: 'Official Zones' })).toBeNull();
    await expect(within(realms).getByRole('link', { name: 'Books' })).toHaveAttribute('href', localizedPath(spaceHref('books', 'community'), 'en'));
    // Moderation follows the reader's pinned and community sections.
    const manage = within(within(nav).getByRole('region', { name: 'Moderation' })).getByRole('link', { name: /^Manage/ });
    await expect(manage).toHaveTextContent('8 waiting');
    await expect(manage).toHaveAttribute('href', `/en/manage/r/${realm(2).slice(-36)}`);
    await expect(realms.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(within(canvasElement.querySelector('header')!).getByRole('link', { name: 'Notifications, 3 unread' }))
      .toHaveAttribute('href', '/en/notifications');
    await expect(within(nav).getByRole('link', { name: /^Notifications/ })).toHaveTextContent('3');
  },
};

const localizedOfficialCommunities = withZoneAddress(communities.followed!.realms, [
  { ...communities.official[1]!, href: localizedPath(spaceHref('图书', 'site'), 'zh-Hant') },
]);

/** Official site addresses retain the follow's identity and activity on the community surface. */
export const LocalizedOfficialCommunity: Story = {
  args: { signedIn: true, communities: <CommunityNav data={{ ...communities,
    followed: { zones: [], realms: localizedOfficialCommunities } }} /> },
  async play({ canvasElement }) {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Main navigation' });
    const realms = within(nav).getByRole('region', { name: 'Communities and sites' });
    await expect(await within(realms).findByRole('link', { name: 'Books' })).toHaveAttribute('href',
      localizedPath(spaceHref('图书', 'community'), 'en'));
    await expect(localizedOfficialCommunities[2]).toEqual({ ...communities.followed!.realms[2]!,
      href: spaceHref('图书', 'community') });
    await expect(localizedOfficialCommunities[0]).toBe(communities.followed!.realms[0]);
    await expect(withZoneAddress(communities.followed!.realms, [
      { ...communities.official[1]!, href: '/invalid' },
    ])).toEqual(communities.followed!.realms);
  },
};

/** Collapsed to icons, a community with new activity keeps its dot. */
export const CommunitiesCollapsed: Story = {
  args: { signedIn: true, navCollapsed: true, communities: <CommunityNav data={communities} />,
    account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth.en} /> },
  parameters: { navCollapsed: true, route: { pathname: '/en' } },
  async play({ canvasElement }) {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Main navigation' });
    await expect(within(nav).getByRole('link', { name: /^中文网络小说\s*, new posts$/ })).toBeVisible();
  },
};

export const CommunitiesChinese: Story = {
  args: { locale: 'zh-Hans', messages: zhHansShellMessages, signedIn: true,
    communities: <CommunityNav data={{ ...communities,
      followed: { zones: [], realms: [
        { ...communities.followed!.realms[0]!, name: '中文网络小说' },
        { ...communities.followed!.realms[2]!, name: '图书', language: 'zh-Hans', direction: 'ltr' },
      ] },
      official: [{ ...communities.official[0]!, name: '小说', language: 'zh-Hans' }] }} />,
    account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn}
      messages={auth['zh-Hans']} /> },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/zh-Hans/r' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: '打开导航' }));
    const drawer = within(await within(document.body).findByRole('dialog'));
    await expect(drawer.getByText('中文网络小说')).toHaveAttribute('lang', 'zh-Hans');
    await expect(drawer.getByText('图书')).toHaveAttribute('dir', 'ltr');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    // The drawer and the bottom bar share one name. The modal hides the bar on the next frame,
    // and the accessibility check runs as soon as play returns.
    await waitFor(() => expect(within(document.body).getAllByRole('navigation', { name: '主导航' })).toHaveLength(1),
      { timeout: 5000 });
  },
};

/** On phones the bar's Notifications item carries the count and the drawer lists the communities. */
export const PhoneCommunities: Story = {
  args: { signedIn: true, communities: <CommunityNav data={communities} />,
    account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth.en} /> },
  globals: { viewport: { value: 'phone' } },
  parameters: { route: { pathname: '/en' } },
  beforeEach() { setUnread({ count: 120, overflow: true }); },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const bar = canvas.getByRole('navigation', { name: 'Main navigation' });
    await expect(within(bar).getByRole('link', { name: 'Notifications · Notifications, 99+ unread' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Open navigation' }));
    const drawer = within(await within(document.body).findByRole('dialog', { name: 'Menu' }, { timeout: 5000 }));
    await waitFor(() => expect(drawer.getByRole('region', { name: 'Communities and sites' })).toBeVisible());
    await whenSettled('Menu');
    await userEvent.click(drawer.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(within(document.body).queryByRole('dialog')).toBeNull(), { timeout: 5000 });
  },
};

/** Signed in, a display-mode choice is saved to the Account; when that fails, a quiet note says it still applies here. */
export const DisplayModeNotSaved: Story = {
  args: { signedIn: true, account: <AccountMenu accountOrigin="https://account.rezics.test" session={signedIn} messages={auth.en} /> },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Account menu' }));
    const menu = within(await within(document.body).findByRole('menu'));
    await waitFor(() => expect(menu.getByRole('menuitem', { name: 'Appearance: Light' })).toBeVisible());
    await userEvent.click(menu.getByRole('menuitem', { name: 'Appearance: Light' }));
    await userEvent.click(await within(document.body).findByRole('menuitemradio', { name: 'Dark' }));
    await expect(document.documentElement).toHaveClass('dark');
    // Storybook has no Account behind /api/preferences, so the save fails.
    const note = await canvas.findByText('Couldn’t save your display mode to your account. It still applies on this device.');
    await userEvent.click(within(note.closest('[role="status"]') as HTMLElement).getByRole('button', { name: 'Close' }));
    await expect(canvas.queryByText(/Couldn’t save your display mode/)).toBeNull();
  },
};
