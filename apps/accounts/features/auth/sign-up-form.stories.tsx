import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { SignUpForm } from './sign-up-form.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { AuthFrame } from '../shell/auth-frame.tsx';

const meta = {
  title: 'Accounts/Create account', component: SignUpForm, args: { next: '/' },
  decorators: [Story => <AuthFrame><Story /></AuthFrame>],
} satisfies Meta<typeof SignUpForm>;
export default meta;
type Story = StoryObj<typeof meta>;

async function fill(canvasElement: HTMLElement, password = 'long pass phrase', confirm = password) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Name' }), 'Ada Lovelace');
  await userEvent.type(canvas.getByRole('textbox', { name: 'Email' }), 'ada@example.test');
  await userEvent.type(canvas.getByLabelText('Password'), password);
  await userEvent.type(canvas.getByLabelText('Confirm'), confirm);
  await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
  return canvas;
}

const created = fn();
export const Form: Story = {
  parameters: { account: { navigate: created } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Create your REZICS Account' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
    await expect(canvas.getByText('Enter your name')).toBeVisible();
    await expect(canvas.getByText('Enter an email')).toBeVisible();
    await expect(canvas.getByText('Use 12 characters or more for your password')).toBeVisible();
    await userEvent.clear(canvas.getByLabelText('Password'));
    await fill(canvasElement);
    await expect(created).toHaveBeenCalledWith('/');
  },
};

export const PasswordsDiffer: Story = {
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement, 'long pass phrase', 'another phrase');
    await expect(canvas.getByText('Those passwords didn’t match. Try again.')).toBeVisible();
  },
};

export const CheckYourEmail: Story = {
  parameters: { account: { api: { signUp: async () => ({ ok: true, data: { verify: true } }) } } },
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    await expect(await canvas.findByRole('heading', { name: 'Check your email' })).toBeVisible();
    await expect(canvas.getByText(/If ada@example\.test can be used for a REZICS Account/)).toBeVisible();
  },
};

export const CouldNotCreate: Story = {
  parameters: { account: { api: { signUp: async () => ({ ok: false, kind: 'failed', status: 422 }) } } },
  async play({ canvasElement }) {
    const canvas = await fill(canvasElement);
    // The same words whether or not the email already has an account.
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'We couldn’t create an account with these details. If you already have one, sign in or reset your password.');
  },
};

const signedUp = fn(async () => ({ ok: true as const, data: { verify: true } }));
export const ForAnApp: Story = {
  args: { appName: 'Reader', oauthQuery: 'client_id=reader&sig=abc&ba_param=client_id',
    carry: 'client_id=reader&sig=abc&ba_param=client_id' },
  parameters: { account: { api: { signUp: signedUp } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('One account for every REZICS product, starting with Reader')).toBeVisible();
    await fill(canvasElement);
    // The account keeps the page's language; verification returns to the app's request.
    await expect(signedUp).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en',
      carry: 'client_id=reader&sig=abc&ba_param=client_id' }));
    await expect(await canvas.findByRole('link', { name: 'Back to sign in' }))
      .toHaveAttribute('href', '/sign-in?client_id=reader&sig=abc&ba_param=client_id&sign_in=1');
  },
};

export const Dark: Story = { ...Form, globals: dark };
export const Phone: Story = { ...Form, globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '创建您的 REZICS 账号' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '下一步' }));
    await expect(canvas.getByText('请输入您的姓名')).toBeVisible();
  },
};
