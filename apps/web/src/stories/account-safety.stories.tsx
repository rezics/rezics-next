import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AccountSafetyCard, type AccountSafetyProps } from '../settings/account-safety';
import { accountRenameNavigation } from '../settings/account-rename-actions';
import { m } from '../paraglide/messages.js';

function SignedInSafety(props: Extract<AccountSafetyProps, { state: 'signed-in' }>) {
  return <AccountSafetyCard {...props} />;
}

const identity = { accountId: '123e4567-e89b-42d3-a456-426614174000', handle: 'alice', available: false };
const meta = {
  title: 'Patterns/Account/Account safety recovery',
  component: SignedInSafety,
  parameters: { layout: 'padded' },
  args: {
    state: 'signed-in',
    securityHref: 'https://auth.example.test/security',
    csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
    onReload() {},
    renameAccount: identity,
    renameRead: { loading: false, reload() {} },
  },
} satisfies Meta<typeof SignedInSafety>;
export default meta;
type Story = StoryObj<typeof meta>;

// Presentation of the read envelope only; these states do not establish native or visual proof.
async function waiting({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByText(m.settings_account_rename_failed())).toBeVisible();
  await expect(canvas.getByText(m.settings_retry_wait())).toBeVisible();
  await expect(
    canvas.getByRole('button', {
      name: `${m.settings_reload()}: ${m.settings_account_rename_heading()}`,
    }),
  ).toBeDisabled();
  await expect(canvas.queryByRole('link', { name: m.settings_account_rename_continue() })).toBeNull();
}

export const RateLimitedPhone: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  args: {
    renameRead: {
      loading: false,
      reload() {},
      failures: [{ kind: 'failed', status: 429, code: 'rate_limited', retryAfter: '60' }],
    },
  },
  play: waiting,
};

export const ServiceWaitDesktop: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  args: {
    renameAccount: null,
    renameRead: {
      loading: false,
      reload() {},
      failures: [{ kind: 'failed', status: 503, code: 'dependency_unavailable', retryAfter: '60' }],
    },
  },
  play: waiting,
};

export const DeniedDesktop: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  args: { renameRead: { loading: false, reload() {}, failures: [{ kind: 'denied', status: 403, code: 'forbidden' }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.settings_account_rename_denied())).toBeVisible();
    await expect(
      canvas.getByRole('button', {
        name: `${m.settings_reload()}: ${m.settings_account_rename_heading()}`,
      }),
    ).toBeEnabled();
    await expect(canvas.queryByRole('link', { name: m.settings_account_rename_continue() })).toBeNull();
  },
};

export const DeploymentUnavailablePhone: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  args: {
    renameAccount: accountRenameNavigation(
      { AUTH_ISSUER: 'https://auth.example.test' },
      { ...identity, available: true },
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.settings_account_rename_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.settings_account_rename_continue() })).toBeNull();
    await expect(canvas.getByRole('link', { name: m.account_security_settings() })).toBeVisible();
  },
};

/** The retired context is absent while a fresh owner prepares its original read. UNRUN. */
export const SessionRecovery: Story = {
  args: { renameAccount: null, renameRead: { loading: true, reload() {} } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('@alice')).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.settings_account_rename_continue() })).toBeNull();
    await expect(
      canvas.getByRole('button', { name: `${m.settings_reload()}: ${m.settings_account_rename_heading()}` }),
    ).toBeDisabled();
    await expect(canvas.getByRole('link', { name: m.account_security_settings() })).toBeVisible();
  },
};
