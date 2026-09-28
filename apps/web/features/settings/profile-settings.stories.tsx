import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AgentOption } from '../auth/acting-identity.ts';
import type { PublicAgentProfile } from '../auth/agent-profile.ts';
import { ProfileSettings } from './profile-settings.tsx';
import { type SettingsMessages, englishMessages } from './messages.ts';
import zhHant from './messages/zh-Hant.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';

const person: AgentOption = { iri: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
  label: 'Ada Lovelace', handle: 'ada', kind: 'person', path: 'direct-principal' };
const profile: PublicAgentProfile = { id: person.iri, displayName: 'Ada Lovelace',
  revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
  bio: { text: 'Reader and writer', language: 'en' }, avatarSelection: null, avatarUrl: null };
const meta = { title: 'Settings/Profile', component: ProfileSettings,
  args: { agent: person, profile, locale: 'en', error: null, updated: null, preview: true,
    accountOrigin: 'https://account.rezics.test' },
} satisfies Meta<typeof ProfileSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Person: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Profile settings' })).toBeVisible();
    await expect(canvas.getByText('@ada')).toBeVisible();
    await expect(canvas.getByText(/This public name began with your Account name/)).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Display name' })).toHaveValue('Ada Lovelace');
    await expect(canvas.getByRole('textbox', { name: 'Bio' })).toHaveValue('Reader and writer');
    await expect(canvas.getByText('Choose image')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save public profile' })).toBeEnabled();
    await expect(canvas.getByText(/30 days/)).toBeVisible();
    await expect(canvas.getByRole('status')).toHaveTextContent('current handle');
    await expect(canvas.getByRole('button', { name: 'Change handle' })).toBeDisabled();
    await expect(canvas.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(canvas.getByRole('switch', { name: 'Replies · In-app' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Library and shelves' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Profile visibility' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Who can follow you' })).toBeVisible();
    await expect(canvas.getByRole('switch', { name: 'Hide my reading activity from other people’s Home' }))
      .toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Content languages' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Unread chapter spoilers' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Theme' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Open Accounts' }))
      .toHaveAttribute('href', 'https://account.rezics.test');
  },
};

export const PenName: Story = {
  // A pen name has a public profile of its own; the settings show its name, not the person's.
  args: { agent: { ...person, label: 'Aster', handle: 'aster', kind: 'pen-name',
    path: 'represented-agent' }, profile: { ...profile, displayName: 'Aster', bio: null } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Aster')).toBeVisible();
    await expect(canvas.getByText(/Changes here appear publicly for this Agent/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save public profile' })).toBeEnabled();
  },
};

export const Cooldown: Story = {
  args: { error: 'cooldown' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText(/You can change your handle again 30 days/)).toBeVisible();
  },
};

export const NoEligibleAgent: Story = {
  args: { agent: null, profile: null },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Choose a profile' }))
      .toHaveAttribute('href', '/en/identity');
  },
};

export const ProfileUnavailable: Story = {
  args: { profile: null },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Profile editing is temporarily unavailable/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save public profile' })).toBeDisabled();
  },
};

export const ChinesePhone: Story = {
  args: { locale: 'zh-Hans' },
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: '个人资料设置' })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: '隐私' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: '书库和书架' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: '资料可见范围' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: '未读章节剧透' })).toBeVisible();
    await expect(canvas.getByText('选择图片')).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

const localizedPhone = (locale: 'zh-Hant' | 'ja' | 'ko', translated: Partial<SettingsMessages>): Story => {
  const messages: SettingsMessages = { ...englishMessages, ...translated };
  return {
    args: { locale, messages },
    globals: { locale, viewport: { value: 'phone' } },
    async play({ canvasElement }) {
      const canvas = within(canvasElement);
      await expect(canvas.getByRole('heading', { name: messages.pageTitle })).toBeVisible();
      await expect(canvas.getByRole('heading', { name: messages.notificationsTitle })).toBeVisible();
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  };
};

export const TraditionalChinesePhone: Story = localizedPhone('zh-Hant', zhHant);
export const JapanesePhone: Story = localizedPhone('ja', ja);
export const KoreanPhone: Story = localizedPhone('ko', ko);
