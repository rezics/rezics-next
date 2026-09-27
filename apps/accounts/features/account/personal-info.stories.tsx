import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { PersonalInfo } from './personal-info.tsx';
import { AccountFrame, ada } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { ReadStatePanel } from '../shell/state-panel.tsx';

const meta = {
  title: 'Accounts/Account centre/Personal info', component: PersonalInfo, args: { user: ada },
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
    await expect(canvas.getByRole('combobox', { name: '语言' })).toHaveValue('zh-CN');
  },
};
