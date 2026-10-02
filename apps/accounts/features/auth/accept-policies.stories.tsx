import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AcceptPolicies, PoliciesUnavailable } from './accept-policies.tsx';
import { policyFixture } from './policies.fixture.ts';
import { chinese, dark, phone } from '../../.storybook/variants.ts';
import { AuthFrame } from '../shell/auth-frame.tsx';

const meta = {
  title: 'Accounts/Accept changed policies', component: AcceptPolicies,
  args: { policies: policyFixture, aboutOrigin: 'https://rezics.example', next: '/api/auth/oauth2/authorize?client_id=reader' },
  decorators: [Story => <AuthFrame><Story /></AuthFrame>],
} satisfies Meta<typeof AcceptPolicies>;
export default meta;
type Story = StoryObj<typeof meta>;

const navigated = fn();
const accepted = fn(async () => ({ ok: true as const, data: undefined }));
export const AcceptAndContinue: Story = {
  parameters: { account: { navigate: navigated, api: { acceptPolicies: accepted } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Our policies changed' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Terms of Service' }))
      .toHaveAttribute('href', 'https://rezics.example/en/legal/terms/');
    await userEvent.click(canvas.getByRole('button', { name: 'Accept and continue' }));
    // The same two versions that were shown, then the refused request resumes.
    await expect(accepted).toHaveBeenCalledWith([{ policyId: 'terms', versionDigest: 'a'.repeat(64) },
      { policyId: 'privacy', versionDigest: 'b'.repeat(64) }]);
    await expect(navigated).toHaveBeenCalledWith('/api/auth/oauth2/authorize?client_id=reader');
  },
};

export const CouldNotSave: Story = {
  parameters: { account: { api: { acceptPolicies: async () => ({ ok: false, kind: 'unavailable', status: 503 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Accept and continue' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('We could not reach the REZICS Account service.');
  },
};

export const Unavailable: Story = {
  render: () => <PoliciesUnavailable />,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByText(/Reload this page to try again/)).toBeVisible();
  },
};
export const Dark: Story = { globals: dark };
export const Phone: Story = { globals: phone };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: '我们的政策已更新' })).toBeVisible();
    await expect(canvas.getByText('政策以英文发布，以英文文本为准。')).toBeVisible();
  },
};

const signedOut = fn(async () => ({ ok: true as const, data: undefined }));
const declined = fn();
export const DeclineAndSignOut: Story = {
  args: { signIn: '/sign-in?client_id=reader&policy_declined=1' },
  parameters: { account: { navigate: declined, api: { signOut: signedOut } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Decline and sign out' }));
    await expect(signedOut).toHaveBeenCalledOnce();
    await expect(declined).toHaveBeenCalledWith('/sign-in?client_id=reader&policy_declined=1');
  },
};

const stayed = fn();
export const DeclineCouldNotSignOut: Story = {
  parameters: { account: { navigate: stayed,
    api: { signOut: async () => ({ ok: false, kind: 'unavailable', status: 503 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Decline and sign out' }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(stayed).not.toHaveBeenCalled();
    await expect(canvas.getByRole('button', { name: 'Decline and sign out' })).toBeEnabled();
  },
};

export const PoliciesChangedAgain: Story = {
  parameters: { account: { api: {
    acceptPolicies: async () => ({ ok: false, kind: 'policy-acceptance-required', status: 409 }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Accept and continue' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Reload the page');
  },
};
