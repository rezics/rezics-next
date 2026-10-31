import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { SettingsSessionRecovery, SignedOutSettings } from '../../settings/settings-page';
import { PageHeading } from '../../shell/page-heading';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';

const meta = {
  title: 'Pages/Account/Settings session recovery',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual isolated Settings recovery component in AppShell. Session status and retry IO are illustrative local inputs: a short pending read either rejects again or resolves signed out. No positive session, subject or CSRF is seeded. These stories do not establish native, runtime, visual or journey acceptance. Review at phone390/desktop1280 with shared locale and theme globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Scenario = 'pending' | 'error' | 'retry-fails' | 'signed-out';

function RecoveryExample({ scenario }: { scenario: Scenario }) {
  const [retrying, setRetrying] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const running = useRef(false);
  const retry = async () => {
    if (running.current) return;
    running.current = true;
    setRetrying(true);
    try {
      // Illustrative IO only; production uses the installed session query and guarded route.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      if (scenario !== 'signed-out') throw new Error('Illustrative session transport failure');
      setSignedOut(true);
    } catch {
      // Retain the same actionable settled failure after a rejected read.
    } finally {
      running.current = false;
      setRetrying(false);
    }
  };
  return (
    <AppShell>
      <article className="mx-auto w-full max-w-6xl space-y-8 px-4 text-foreground sm:px-6">
        <PageHeading>{m.settings_heading()}</PageHeading>
        {signedOut ? (
          <SignedOutSettings returnTo={`/${getLocale()}/settings?from=account#display`} />
        ) : (
          <SettingsSessionRecovery
            state="unknown"
            sessionRead={{ status: scenario === 'pending' ? 'pending' : 'error', fetchStatus: 'idle' }}
            retrying={retrying}
            onRetry={() => void retry()}
          />
        )}
      </article>
    </AppShell>
  );
}

function Example({ scenario }: { scenario: Scenario }) {
  return (
    <PatternStory visitor="Signed Out" path="/settings?from=account#display">
      <RecoveryExample scenario={scenario} />
    </PatternStory>
  );
}

async function recoveryView(canvasElement: HTMLElement) {
  const view = within(await within(canvasElement).findByRole('main'));
  await expect(view.getByRole('region', { name: m.settings_display_heading() })).toBeVisible();
  const display = view.getByRole('region', { name: m.shell_appearance() });
  await expect(view.getAllByRole('region', { name: m.shell_appearance() })).toHaveLength(1);
  await expect(
    within(display).getByRole('button', { name: (name) => name.startsWith(m.shell_language()) }),
  ).toBeEnabled();
  await expect(within(display).getByRole('button', { name: m.shell_theme() })).toBeEnabled();
  await expect(view.queryByRole('region', { name: m.settings_reading_heading() })).toBeNull();
  await expect(view.queryByRole('region', { name: m.settings_notifications_heading() })).toBeNull();
  await expect(canvasElement.querySelector('[name="csrf_token"]')).toBeNull();
  await expect(within(canvasElement).getAllByRole('main')).toHaveLength(1);
  return view;
}

export const Pending: Story = {
  render: () => <Example scenario="pending" />,
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = await recoveryView(canvasElement);
    await expect(view.getByRole('status')).toHaveTextContent(m.settings_sections_loading());
    await expect(view.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await expect(view.queryByRole('button', { name: m.settings_retry() })).toBeNull();
    await expect(view.queryByRole('link', { name: m.account_sign_in() })).toBeNull();
  },
};

export const SettledError: Story = {
  render: () => <Example scenario="error" />,
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const view = await recoveryView(canvasElement);
    await expect(view.getByRole('status')).toHaveTextContent(m.settings_session_unavailable());
    const retry = view.getByRole('button', { name: m.settings_retry() });
    await expect(retry).toBeEnabled();
    retry.focus();
    await expect(retry).toHaveFocus();
  },
};

export const RetryFails: Story = {
  render: () => <Example scenario="retry-fails" />,
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = await recoveryView(canvasElement);
    const retry = view.getByRole('button', { name: m.settings_retry() });
    await userEvent.click(retry);
    await expect(retry).toBeDisabled();
    await expect(view.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(retry).toBeEnabled());
    await expect(view.getByRole('status')).toHaveTextContent(m.settings_session_unavailable());
    await expect(view.getAllByRole('button', { name: m.settings_retry() })).toHaveLength(1);
  },
};

export const RecoveredSignedOut: Story = {
  render: () => <Example scenario="signed-out" />,
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const view = await recoveryView(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.settings_retry() }));
    const signIn = await view.findByRole('link', { name: m.account_sign_in() });
    await expect(signIn).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/settings?from=account#display`)}`,
    );
    await expect(view.queryByText(m.settings_session_unavailable())).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_retry() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.account_sign_out() })).toBeNull();
    await recoveryView(canvasElement);
  },
};
