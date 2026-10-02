import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { AccountMenu } from './account-menu.tsx';
import { messages } from './messages.ts';
import type { Session } from './session.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import shellZhHans from '../shell/messages/zh-Hans.ts';
import { ShellProvider } from '../shell/shell-provider.tsx';

const ada = 'https://rezics.com/id/b8df6385-cec9-4fa0-8b89-71def5fa82b5';
const pen = 'https://rezics.com/id/1e1489d5-6994-402c-99f2-50547eeaef4d';
const agents: Session['agents'] = [{ iri: ada, label: 'Aster', handle: 'aster',
  kind: 'pen-name', path: 'direct-principal' },
  { iri: pen, label: null, handle: null, kind: null, path: 'represented-agent' }];
const session: Session = { user: { id: 'u1' },
  agent: { status: 'selected', agent: agents[0]! }, agents, expiresAt: '2026-10-27T00:00:00.000Z' };

const meta = { title: 'Auth/Account menu', component: AccountMenu,
  args: { session, messages: messages.en, accountOrigin: 'https://account.rezics.test' },
  decorators: [(Story, context) => {
    const locale = context.globals.locale === 'zh-Hans' ? 'zh-Hans' : 'en';
    return <ShellProvider locale={locale} messages={locale === 'zh-Hans' ? { ...shellMessages, ...shellZhHans } : shellMessages} initialTheme="system"
      initialCollapsed={false}><div className="flex justify-end p-4"><Story /></div></ShellProvider>;
  }],
} satisfies Meta<typeof AccountMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Account menu' });
    await expect(trigger).toHaveTextContent('Aster');
    await expect(trigger).toHaveTextContent('@aster');
    await userEvent.click(trigger);
    if (window.matchMedia('(max-width: 639px)').matches) {
      const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: 'Account menu' },
        { timeout: 5000 });
      await expect(within(dialog).getByRole('button', { name: 'Switch Agent' })).toBeVisible();
      await expect(within(dialog).getByRole('link', { name: 'Profile' }))
        .toHaveAttribute('href', '/en/@aster');
      return;
    }
    const menu = await within(canvasElement.ownerDocument.body).findByRole('menu');
    // The Account's own name and email are private: the menu shows only the Agent.
    await expect(menu).not.toHaveTextContent('ada@example.test');
    await expect(menu).not.toHaveTextContent('Ada Lovelace');
    await expect(within(menu).getByRole('group', { name: 'Acting as' })).toHaveTextContent('Aster');
    // The menu opens with a short fade and zoom.
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Switch Agent' })).toBeVisible());
    await expect(within(menu).getByRole('menuitem', { name: 'Profile' }))
      .toHaveAttribute('href', '/en/@aster');
    await expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Manage your REZICS Account' }))
      .toHaveAttribute('href', 'https://account.rezics.test');
    await expect(within(menu).getByRole('menuitem', { name: 'Language' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Appearance' })).toBeVisible();
  },
};

export const PhoneSecondPanels: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    const trigger = within(canvasElement).getByRole('button', { name: 'Account menu' });
    await userEvent.click(trigger);
    let dialog = await page.findByRole('dialog', { name: 'Account menu' });
    await expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Language' }));
    dialog = await page.findByRole('dialog', { name: 'Language' });
    await expect(within(dialog).getAllByRole('radio')).toHaveLength(8);
    const back = within(dialog).getByRole('button', { name: 'Back' });
    await waitFor(() => expect(back).toHaveFocus());
    await userEvent.click(back);
    dialog = await page.findByRole('dialog', { name: 'Account menu' });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Language' })).toHaveFocus());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Appearance' }));
    dialog = await page.findByRole('dialog', { name: 'Appearance' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Dark' }));
    await expect(within(dialog).getByRole('radio', { name: 'Dark' })).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    dialog = await page.findByRole('dialog', { name: 'Account menu' });
    await expect(within(dialog).getByRole('link', { name: 'Content preferences' })).toHaveAttribute('href', '/en/settings#reading');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const DesktopSubmenus: Story = {
  async play({ canvasElement }) {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Account menu' }));
    await userEvent.click(await page.findByRole('menuitem', { name: 'Language' }));
    await expect(await page.findByRole('menuitemradio', { name: 'English' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Account menu' }));
    await userEvent.click(await page.findByRole('menuitem', { name: 'Appearance' }));
    await userEvent.click(await page.findByRole('menuitemradio', { name: 'Dark' }));
    await expect(document.documentElement).toHaveClass('dark');
  },
};

export const UnlabeledAgent: Story = {
  args: { session: { ...session, agent: { status: 'selected', agent: agents[1]! } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Account menu' }))
      .toHaveTextContent('Agent 1e1489d5');
  },
};

export const BeforeHandle: Story = {
  args: { session: { ...session, agent: { status: 'selected', agent: { ...agents[0]!,
    handle: 'agent-b8df6385-cec9-4fa0-8b89-71def5fa82b5' } } } },
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Account menu' });
    await expect(trigger).toHaveTextContent('Choose a handle');
    await expect(trigger).not.toHaveTextContent('@agent-b8df6385');
  },
};

export const ChooseAgent: Story = {
  args: { session: { ...session, agent: { status: 'unselected' } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Account menu' }))
      .toHaveTextContent('Choose an Agent');
  },
};

export const AgentNoLongerAvailable: Story = {
  args: { session: { ...session, agent: { status: 'ineligible', previous: pen } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: 'Account menu' }))
      .toHaveTextContent('Agent no longer available');
  },
};

export const LongName: Story = {
  args: { session: { ...session, agent: { status: 'selected', agent: { ...agents[0]!,
    label: 'Augusta Ada King, Countess of Lovelace and Honorary Member of Several Learned Societies' } } } },
};

export const Chinese: Story = {
  args: { messages: messages['zh-Hans'], session: { ...session, agent: { status: 'unselected' } } },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: '账户菜单' });
    await expect(trigger).toHaveTextContent('选择身份');
    await userEvent.click(trigger);
    if (window.matchMedia('(max-width: 639px)').matches) {
      const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog', { name: '账户菜单' });
      await expect(within(dialog).getByRole('button', { name: '退出登录' })).toBeVisible();
      return;
    }
    const menu = await within(canvasElement.ownerDocument.body).findByRole('menu');
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: '退出登录' })).toBeVisible());
  },
};
