import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { RecoverySettings } from './recovery-settings.tsx';
import { DeleteAccount } from './delete-account.tsx';
import { AccountFrame } from '../../.storybook/account-frame.tsx';
import { chinese, dark, phone } from '../../.storybook/variants.ts';

const id = '80000000-0000-4000-8000-000000000001';
const expiry = '2026-11-08T12:00:00Z';
const meta = {
  title: 'Accounts/Account centre/Recovery',
  component: RecoverySettings,
  args: {
    recovery: { status: 'ok', data: { policy: null } },
    invitations: { status: 'ok', data: { items: [], nextCursor: null } },
  },
  decorators: [
    (Story, { parameters }) => (
      <AccountFrame section="security" stepUp={parameters.stepUp}>
        <Story />
      </AccountFrame>
    ),
  ],
} satisfies Meta<typeof RecoverySettings>;
export default meta;
type Story = StoryObj<typeof meta>;

const enrolled = fn(async () => ({
  ok: true as const,
  data: { generation: '0', replayed: false },
}));
export const SetUp: Story = {
  parameters: { account: { api: { enrollRecovery: enrolled } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Guardian email'), 'trusted@example.test');
    await userEvent.type(canvas.getByLabelText('Current password'), 'correct horse battery staple');
    await userEvent.click(
      canvas.getByRole('button', { name: 'Create a code and invite a guardian' }),
    );
    const shown = await canvas.findByRole('textbox', { name: 'Your new recovery code' });
    await expect((shown as HTMLInputElement).value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(enrolled).toHaveBeenCalledWith({
      guardianEmail: 'trusted@example.test',
      recoveryCode: (shown as HTMLInputElement).value,
    });
    await expect(canvas.getByRole('button', { name: 'Done' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('checkbox', { name: 'I saved this recovery code' }));
    await expect(canvas.getByRole('button', { name: 'Done' })).toBeEnabled();
  },
};
export const SetUpPhone: Story = { ...SetUp, globals: phone };

let confirmedWithTotp = false;
const enrollAfterStepUp = fn(async () =>
  confirmedWithTotp
    ? { ok: true as const, data: { generation: '0', replayed: false } }
    : { ok: false as const, kind: 'step-up-required' as const, status: 403 },
);
const confirmEnrollment = fn(async (input: { password: string; totpCode?: string }) => {
  confirmedWithTotp =
    input.password === 'correct horse battery staple' && input.totpCode === '123456';
  return confirmedWithTotp
    ? { ok: true as const, data: undefined }
    : { ok: false as const, kind: 'invalid-credentials' as const, status: 403 };
});
export const StaleSessionWithTotp: Story = {
  parameters: {
    stepUp: { password: true, passkey: false, totp: true },
    account: { api: { enrollRecovery: enrollAfterStepUp, reauthenticate: confirmEnrollment } },
  },
  beforeEach() {
    confirmedWithTotp = false;
    enrollAfterStepUp.mockClear();
    confirmEnrollment.mockClear();
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Guardian email'), 'trusted@example.test');
    await userEvent.type(canvas.getByLabelText('Current password'), 'correct horse battery staple');
    await userEvent.click(
      canvas.getByRole('button', { name: 'Create a code and invite a guardian' }),
    );
    const dialog = within(await screen.findByRole('dialog', { name: 'Confirm it’s you' }));
    await expect(enrollAfterStepUp).toHaveBeenCalledTimes(1);
    await expect(confirmEnrollment).not.toHaveBeenCalled();
    await expect(canvas.queryByRole('textbox', { name: 'Your new recovery code' })).toBeNull();
    await expect(dialog.queryByLabelText('Enter your password')).toBeNull();
    await userEvent.click(dialog.getByRole('button', { name: /^Confirm$/ }));
    await expect(confirmEnrollment).not.toHaveBeenCalled();
    await expect(enrollAfterStepUp).toHaveBeenCalledTimes(1);
    await userEvent.type(
      dialog.getByRole('textbox', { name: 'Code from your authenticator app' }),
      '123456',
    );
    await userEvent.click(dialog.getByRole('button', { name: /^Confirm$/ }));
    await expect(confirmEnrollment).toHaveBeenCalledWith({
      password: 'correct horse battery staple',
      totpCode: '123456',
    });
    const shown = await canvas.findByRole('textbox', { name: 'Your new recovery code' });
    await expect(enrollAfterStepUp).toHaveBeenCalledTimes(2);
    await expect(enrollAfterStepUp.mock.calls[0]).toEqual(enrollAfterStepUp.mock.calls[1]);
    await expect(enrollAfterStepUp).toHaveBeenLastCalledWith({
      guardianEmail: 'trusted@example.test',
      recoveryCode: (shown as HTMLInputElement).value,
    });
  },
};

const renewed = fn(async () => ({ ok: true as const, data: { generation: '1', replayed: false } }));
export const RenewAcceptedGuardian: Story = {
  args: {
    recovery: {
      status: 'ok',
      data: {
        policy: {
          invitationId: id,
          guardianEmail: 'trusted@example.test',
          state: 'accepted',
          expiresAt: expiry,
          hasCode: true,
        },
      },
    },
  },
  parameters: { account: { api: { enrollRecovery: renewed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Guardian accepted')).toBeVisible();
    await userEvent.type(canvas.getByLabelText('Current recovery code'), 'A'.repeat(43));
    await userEvent.type(canvas.getByLabelText('Current password'), 'correct horse battery staple');
    await userEvent.click(canvas.getByRole('button', { name: 'Renew recovery code' }));
    await canvas.findByRole('textbox', { name: 'Your new recovery code' });
    await expect(renewed).toHaveBeenCalledWith(
      expect.objectContaining({ previousRecoveryCode: 'A'.repeat(43) }),
    );
  },
};

const uncertain = fn(
  async (): Promise<
    | { ok: false; kind: 'unavailable'; status: number }
    | {
        ok: true;
        data: { generation: string; replayed: boolean };
      }
  > =>
    uncertain.mock.calls.length === 1
      ? { ok: false, kind: 'unavailable', status: 0 }
      : { ok: true, data: { generation: '0', replayed: true } },
);
export const LostResponseRetry: Story = {
  parameters: { account: { api: { enrollRecovery: uncertain } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Guardian email'), 'trusted@example.test');
    await userEvent.type(canvas.getByLabelText('Current password'), 'correct horse battery staple');
    await userEvent.click(
      canvas.getByRole('button', { name: 'Create a code and invite a guardian' }),
    );
    await expect(
      await canvas.findByText(
        'We could not confirm whether setup completed. Keep this code and retry.',
      ),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Retry setup' }));
    await waitFor(() => expect(uncertain).toHaveBeenCalledTimes(2));
    await expect(uncertain.mock.calls[0]).toEqual(uncertain.mock.calls[1]);
    await expect(
      await canvas.findByRole('checkbox', { name: 'I saved this recovery code' }),
    ).toBeVisible();
  },
};

const changed = fn(async (_id: string, action: string) => ({
  ok: true as const,
  data: {
    state: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'withdrawn',
    replayed: false,
  },
}));
export const AcceptThenWithdraw: Story = {
  args: {
    invitations: {
      status: 'ok',
      data: {
        items: [
          {
            invitationId: id,
            ownerEmail: 'friend@example.test',
            state: 'pending',
            expiresAt: expiry,
          },
        ],
        nextCursor: null,
      },
    },
  },
  parameters: { account: { api: { changeGuardian: changed } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Accept invitation' }));
    await expect(await canvas.findByText('Invitation accepted.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Withdraw' }));
    await expect(
      await canvas.findByText(
        'You withdrew. The current recovery code and your approvals are no longer usable.',
      ),
    ).toBeVisible();
    await expect(changed).toHaveBeenCalledWith(id, 'accept');
    await expect(changed).toHaveBeenCalledWith(id, 'withdraw');
  },
};
export const PendingPhone: Story = {
  args: AcceptThenWithdraw.args,
  globals: phone,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Accept invitation' })).toBeVisible();
    await expect(canvas.getByText(/must withdraw before deleting/)).toBeVisible();
  },
};
export const Decline: Story = {
  args: AcceptThenWithdraw.args,
  parameters: AcceptThenWithdraw.parameters,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Decline invitation' }));
    await expect(await canvas.findByText('Invitation declined.')).toBeVisible();
    await expect(
      canvas.queryByRole('button', { name: 'Accept invitation' }),
    ).not.toBeInTheDocument();
  },
};
export const Expired: Story = {
  args: {
    recovery: {
      status: 'ok',
      data: {
        policy: {
          invitationId: id,
          guardianEmail: 'trusted@example.test',
          state: 'expired',
          expiresAt: '2026-10-01T12:00:00Z',
          hasCode: true,
        },
      },
    },
  },
};
export const Withdrawn: Story = {
  args: {
    recovery: {
      status: 'ok',
      data: {
        policy: {
          invitationId: id,
          guardianEmail: 'trusted@example.test',
          state: 'withdrawn',
          expiresAt: expiry,
          hasCode: false,
        },
      },
    },
  },
};
export const DeletionDuty: Story = {
  render: () => <DeleteAccount guardianDuty />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Withdraw from active guardianships before deleting/),
    ).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Manage guardianships' })).toHaveAttribute(
      'href',
      '/security/recovery',
    );
    await expect(canvas.getByRole('button', { name: 'Delete account' })).toBeDisabled();
  },
};
export const Unavailable: Story = {
  args: { recovery: { status: 'unavailable' }, invitations: { status: 'unavailable' } },
};
export const Chinese: Story = { args: AcceptThenWithdraw.args, globals: chinese };
export const GermanPhone: Story = {
  args: AcceptThenWithdraw.args,
  globals: { ...phone, locale: 'de' },
};
export const Dark: Story = { args: AcceptThenWithdraw.args, globals: dark };
