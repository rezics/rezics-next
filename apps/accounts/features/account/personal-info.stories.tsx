import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { PersonalInfo } from './personal-info.tsx';
import { AccountFrame, ada } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { ReadStatePanel } from '../shell/state-panel.tsx';

const meta = {
  title: 'Accounts/Account centre/Personal info', component: PersonalInfo, args: { user: ada,
    preferences: { status: 'ok', data: { revision: 0, displayMode: 'system', showZoneThemes: true } } },
  decorators: [Story => <AccountFrame section="personal-info"><Story /></AccountFrame>],
} satisfies Meta<typeof PersonalInfo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Details: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Personal info' })).toBeVisible();
    await expect(canvas.getByText('Ada Lovelace', { selector: 'span' })).toBeVisible();
    await expect(canvas.getByText('Verified')).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    await expect(canvas.getByRole('combobox', { name: 'Display mode' })).toHaveValue('system');
    await expect(canvas.getByRole('combobox', { name: 'Show Zone themes' })).toHaveValue('yes');
    await expect(canvas.queryByText('Coming soon')).toBeNull();
  },
};

const savedDisplay = fn(async (value: { revision: number; displayMode: 'system' | 'light' | 'dark';
  showZoneThemes: boolean }) => ({ ok: true as const, data: { ...value, revision: value.revision + 1 } }));
export const ChooseDisplay: Story = {
  parameters: { account: { api: { setDisplayPreferences: savedDisplay } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Display mode' }), 'dark');
    await expect(savedDisplay).toHaveBeenCalledWith({ revision: 0, displayMode: 'dark', showZoneThemes: true });
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Show Zone themes' }), 'no');
    await expect(savedDisplay).toHaveBeenCalledWith({ revision: 1, displayMode: 'dark', showZoneThemes: false });
  },
};

export const DisplayUnavailable: Story = {
  args: { preferences: { status: 'unavailable' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('combobox', { name: 'Display mode' })).toBeNull();
    await expect(canvas.getByText(/We could not reach the REZICS Account service/)).toBeVisible();
  },
};

const chosen = fn(async () => ({ ok: true as const, data: undefined }));
const reloaded = fn();
export const ChooseLanguage: Story = {
  parameters: { account: { navigate: reloaded, api: { setLocale: chosen } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Language' }), 'zh-Hans');
    // Stored on the account, then remembered in this browser through ?hl=.
    await expect(chosen).toHaveBeenCalledWith('zh-Hans');
    await waitFor(() => expect(reloaded).toHaveBeenCalledWith(expect.stringContaining('hl=zh-Hans')));
  },
};

const refreshed = fn();
const renamed = fn(async () => ({ ok: true as const, data: undefined }));
export const EditName: Story = {
  parameters: { account: { refresh: refreshed, api: { updateName: renamed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Edit · Name' }));
    const field = canvas.getByRole('textbox', { name: 'Name' });
    await userEvent.clear(field);
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(canvas.getByText('Enter your name')).toBeVisible();
    await userEvent.type(field, 'Augusta Ada King');
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(renamed).toHaveBeenCalledWith('Augusta Ada King');
    await expect(refreshed).toHaveBeenCalled();
    await expect(await canvas.findByText('Saved')).toBeVisible();
  },
};

const emailChange = fn(async (): Promise<{ ok: true; data: undefined } | { ok: false; kind: 'step-up-required'; status: number }> =>
  emailChange.mock.calls.length === 1 ? { ok: false, kind: 'step-up-required', status: 403 } : { ok: true, data: undefined });
export const ChangeEmail: Story = {
  parameters: { account: { api: { changeEmail: emailChange } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Change email' }));
    const field = canvas.getByRole('textbox', { name: 'New email' });
    await userEvent.type(field, 'ada@example.test');
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(canvas.getByText('That’s already your email')).toBeVisible();
    await userEvent.clear(field);
    await userEvent.type(field, 'ada@new.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    const confirm = await screen.findByRole('dialog', { name: 'Confirm it’s you' });
    await userEvent.type(within(confirm).getByLabelText('Enter your password'), 'correct horse battery');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Confirm' }));
    await expect(await canvas.findByText(/To confirm, open the link we sent to ada@example\.test\. Then verify ada@new\.example/))
      .toBeVisible();
  },
};

export const ChangeEmailNotAvailable: Story = {
  parameters: { account: { api: { changeEmail: async () => ({ ok: false, kind: 'not-enabled', status: 400 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Change email' }));
    await userEvent.type(canvas.getByRole('textbox', { name: 'New email' }), 'ada@new.example');
    await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Not available yet');
  },
};

export const Unverified: Story = {
  args: { user: { ...ada, emailVerified: false } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Not verified')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Send verification link' }));
    await expect(await canvas.findByText('Check your inbox for a verification link.')).toBeVisible();
  },
};

export const SignedOut: Story = {
  render: () => <ReadStatePanel status="signed-out" next="/personal-info" headingLevel={1} />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { level: 1, name: 'Sign in to continue' })).toBeVisible();
  },
};

export const Dark: Story = { ...Details, globals: dark };
export const Phone: Story = { ...Details, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '个人信息' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: '语言' })).toHaveValue('zh-Hans');
  },
};

export const JapaneseFallback: Story = {
  globals: { locale: 'ja' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '個人情報' })).toBeVisible();
    const language = canvas.getByRole('combobox', { name: '言語' });
    await expect(language).toHaveValue('ja');
    const options = within(language).getAllByRole('option');
    await expect(options.map(option => option.textContent?.trim()))
      .toEqual(['English', '繁體中文', '简体中文', '日本語', '한국어', 'Deutsch', 'Français', 'Español']);
  },
};
