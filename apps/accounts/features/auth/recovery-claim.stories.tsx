import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RecoveryApproval, RecoveryClaimForm } from './recovery-claim-form.tsx';
import { AuthFrame } from '../shell/auth-frame.tsx';
import { dark, phone, chinese } from '../../.storybook/variants.ts';
import type { RecoveryClaim } from '../api/client.ts';

const code = 'a'.repeat(43);
const claim: RecoveryClaim = {
  claimId: '12d0905d-97fa-43f7-a8a2-6829a49f03de',
  targetUserId: 'owner',
  notBefore: '2026-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:00:00.000Z',
  approved: true,
  activated: false,
  replayed: false,
};
const meta = {
  title: 'Accounts/Recovery claim',
  component: RecoveryClaimForm,
  args: { email: 'ada@example.test' },
  decorators: [
    (Story) => (
      <AuthFrame>
        <Story />
      </AuthFrame>
    ),
  ],
  parameters: { account: { api: { requestRecovery: async () => ({ ok: true, data: claim }) } } },
} satisfies Meta<typeof RecoveryClaimForm>;
export default meta;
type Story = StoryObj<typeof meta>;

async function openClaim(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByLabelText('Recovery code'), code);
  await userEvent.click(canvas.getByRole('button', { name: 'Next' }));
  return canvas;
}

export const Request: Story = {};
export const Rebind: Story = {
  async play({ canvasElement }) {
    const canvas = await openClaim(canvasElement);
    await expect(await canvas.findByText(/Recovery removes all existing passkeys/)).toBeVisible();
    await expect(canvas.getByLabelText('Password')).toBeVisible();
  },
};
export const Complete: Story = {
  async play({ canvasElement }) {
    const canvas = await openClaim(canvasElement);
    await userEvent.type(
      await canvas.findByLabelText('Password'),
      'new independently bound password',
    );
    await userEvent.type(canvas.getByLabelText('Confirm'), 'new independently bound password');
    await userEvent.click(canvas.getByRole('button', { name: 'Recover account' }));
    await expect(
      await canvas.findByRole('heading', { name: 'Your account is recovered' }),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/sign-in?next=%2Fsecurity',
    );
  },
};
export const Waiting: Story = {
  parameters: {
    account: {
      api: { requestRecovery: async () => ({ ok: true, data: { ...claim, approved: false } }) },
    },
  },
  async play({ canvasElement }) {
    const canvas = await openClaim(canvasElement);
    await expect(
      await canvas.findByText('Waiting for your recovery guardian’s approval.'),
    ).toBeVisible();
    await expect(canvas.queryByLabelText('Password')).not.toBeInTheDocument();
  },
};
export const Denied: Story = {
  parameters: {
    account: { api: { requestRecovery: async () => ({ ok: false, kind: 'failed', status: 403 }) } },
  },
  async play({ canvasElement }) {
    const canvas = await openClaim(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'This recovery request is unavailable',
    );
    await expect(canvas.getByLabelText('Recovery code')).toHaveValue(code);
  },
};
export const Expired: Story = {
  parameters: {
    account: {
      api: {
        requestRecovery: async () => ({
          ok: true,
          data: {
            ...claim,
            expiresAt: '2026-01-02T00:00:00.000Z',
          },
        }),
      },
    },
  },
  async play({ canvasElement }) {
    const canvas = await openClaim(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'This recovery request expired' }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Start a new recovery request' }));
    await expect(await canvas.findByLabelText('Recovery code')).toHaveValue(code);
  },
};
export const LostResponse: Story = {
  parameters: {
    account: {
      api: { activateRecovery: async () => ({ ok: false, kind: 'unavailable', status: 0 }) },
    },
  },
  async play({ canvasElement }) {
    const canvas = await openClaim(canvasElement);
    await userEvent.type(
      await canvas.findByLabelText('Password'),
      'new independently bound password',
    );
    await userEvent.type(canvas.getByLabelText('Confirm'), 'new independently bound password');
    await userEvent.click(canvas.getByRole('button', { name: 'Recover account' }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(
      'Retry with the same password',
    );
    await expect(canvas.getByLabelText('Password')).toBeDisabled();
  },
};
export const GuardianApproval: Story = {
  render: () => <RecoveryApproval claimId={claim.claimId} />,
  parameters: { account: { api: { approveRecovery: async () => ({ ok: true, data: claim }) } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Approve recovery' }));
    await expect(
      await canvas.findByRole('heading', { name: 'Recovery request approved' }),
    ).toBeVisible();
  },
};
export const Phone: Story = { ...Rebind, globals: phone };
export const Dark: Story = { ...Rebind, globals: dark };
export const Chinese: Story = { globals: chinese };
