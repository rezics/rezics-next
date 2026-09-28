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
const session: Session = { user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.test', image: null },
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
      await expect(within(dialog).getByRole('link', { name: 'Profile settings' }))
        .toHaveAttribute('href', '/en/settings');
      return;
    }
    const menu = await within(canvasElement.ownerDocument.body).findByRole('menu');
    await expect(menu).toHaveTextContent('ada@example.test');
    await expect(within(menu).getByRole('group', { name: 'Acting as' })).toHaveTextContent('Aster');
    // The menu opens with a short fade and zoom.
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'Switch Agent' })).toBeVisible());
    await expect(within(menu).getByRole('menuitem', { name: 'Profile settings' }))
      .toHaveAttribute('href', '/en/settings');
    await expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Manage your REZICS Account' }))
      .toHaveAttribute('href', 'https://account.rezics.test');
    await expect(within(menu).getByRole('menuitem', { name: 'Language' })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Display mode' })).toBeVisible();
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
