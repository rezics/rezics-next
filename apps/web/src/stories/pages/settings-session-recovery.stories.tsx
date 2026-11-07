import type { Meta, StoryObj } from '@storybook/react-vite';
import { StrictMode, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionQuery, useSession } from '../../session/query';
import recording from '../../kernel/recorded/settings-preferences.json';
import { readingFixture } from '../../kernel/fake/settings-preferences-reading';
import type { NotificationWriteResult } from '../../settings/preferences';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { SettingsPageView, SettingsSessionRecovery, SignedOutSettings } from '../../settings/settings-page';
import { settingsContent } from '../../settings/adapters/presentation';
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
          <SignedOutSettings
            returnTo={`/${getLocale()}/settings?from=account#display`}
            SignInPrompt={settingsContent.SignInPrompt}
          />
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

/** Uses the production page, retained editors and owner; only preference transport outcomes are illustrative. */
function ActualSessionPage() {
  const client = useQueryClient();
  const session = useSession();
  const original = useRef(session);
  const [fixture] = useState(() => readingFixture('lost'));
  const [sends, setSends] = useState(0);
  const [reads, setReads] = useState(0);
  const [lastToken, setLastToken] = useState('');
  const [generation, setGeneration] = useState(0);
  if (session.state !== 'signed-in' || !session.subject) return <p role="status">{m.settings_sections_loading()}</p>;
  original.current = session;
  const page = {
    signedIn: true as const,
    accountId: session.subject,
    preferences: fixture.initial,
    notifications: recording.notifications,
    securityHref: null,
  };
  return (
    <>
      <div aria-label="Session regression controls" className="flex flex-wrap gap-2 p-4">
        <button
          type="button"
          onClick={() => {
            const current = client.getQueryData(sessionQuery.queryKey);
            if (!current || current.state !== 'signed-in') return;
            // Retained signed-in data is deliberately unchanged; error then success happen in one event.
            client
              .getQueryCache()
              .find({ queryKey: sessionQuery.queryKey, exact: true })
              ?.setState({
                status: 'error',
                error: new Error('Illustrative session failure with retained data'),
              });
            client.setQueryData(sessionQuery.queryKey, current);
          }}
        >
          Fail session and restore retained data
        </button>
        <button type="button" onClick={() => setGeneration((current) => current + 1)}>
          Mount fresh Settings owner
        </button>
        <button
          type="button"
          onClick={() =>
            client.setQueryData(sessionQuery.queryKey, {
              state: 'signed-in',
              subject: session.subject ?? null,
              csrfToken: null,
            })
          }
        >
          Use read-only session
        </button>
        <button
          type="button"
          onClick={() =>
            client.setQueryData(sessionQuery.queryKey, {
              state: 'signed-in',
              subject: session.subject ?? null,
              csrfToken: 'fresh-story-token',
            })
          }
        >
          Install fresh explicit token
        </button>
        <output aria-label="Preference dispatches">{sends}</output>
        <output aria-label="Preference reads">{reads}</output>
        <output aria-label="Last explicit token">{lastToken}</output>
      </div>
      <AppShell>
        <SettingsPageView
          key={generation}
          page={page}
          csrfToken={session.csrfToken}
          content={settingsContent}
          preferenceIO={{
            read: async () => {
              setReads((current) => current + 1);
              return { ...page, ...(await fixture.io.read()), accountId: original.current.subject ?? null };
            },
            saveReading: async (input, token) => {
              setLastToken(token);
              setSends((current) => current + 1);
              return fixture.io.save(input);
            },
            saveNotifications: async (_, token): Promise<NotificationWriteResult> => {
              setLastToken(token);
              setSends((current) => current + 1);
              return { ok: false, reason: 'unavailable' };
            },
          }}
        />
      </AppShell>
    </>
  );
}

export const RetainedSessionCannotReviveEditors: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings#notifications">
      <StrictMode>
        <ActualSessionPage />
      </StrictMode>
    </PatternStory>
  ),
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const main = within(await canvas.findByRole('main'));
    const toggle = await main.findByRole('switch', { name: m.settings_notification_reply() });
    await userEvent.click(toggle);
    await expect(canvas.getByLabelText('Preference dispatches')).toHaveTextContent('1');
    await userEvent.click(canvas.getByRole('button', { name: 'Fail session and restore retained data' }));
    await main.findByText(m.settings_session_unavailable());
    await expect(main.queryByRole('switch')).toBeNull();
    await expect(canvasElement.querySelector('[name="csrf_token"]')).toBeNull();
    await expect(main.getByRole('region', { name: m.shell_appearance() })).toBeVisible();
    await expect(canvas.getByLabelText('Preference dispatches')).toHaveTextContent('1');
    await userEvent.click(canvas.getByRole('button', { name: 'Mount fresh Settings owner' }));
    await userEvent.click(await main.findByRole('switch', { name: m.settings_notification_reply() }));
    await expect(canvas.getByLabelText('Preference dispatches')).toHaveTextContent('2');
    await expect(main.queryByText(m.settings_session_unavailable())).toBeNull();
  },
};
/** Illustrative transport, actual page ownership and category retention; authored for later integration. */
export const ReadWithoutWriteCredential: Story = {
  render: () => (
    <PatternStory visitor="Signed In" path="/settings#notifications">
      <StrictMode>
        <ActualSessionPage />
      </StrictMode>
    </PatternStory>
  ),
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const main = within(await canvas.findByRole('main'));
    await main.findByRole('switch', { name: m.settings_notification_reply() });
    await userEvent.click(canvas.getByRole('button', { name: 'Use read-only session' }));
    await expect(await main.findByRole('switch', { name: m.settings_notification_reply() })).toBeDisabled();
    await expect(main.queryByText(m.settings_session_unavailable())).toBeNull();
    await userEvent.click(main.getByRole('button', { name: m.settings_reload() }));
    await expect(canvas.getByLabelText('Preference reads')).toHaveTextContent('1');
    await expect(canvas.getByLabelText('Preference dispatches')).toHaveTextContent('0');
    await userEvent.click(main.getByRole('link', { name: m.settings_reading_heading() }));
    await expect(await main.findByRole('radiogroup')).toBeVisible();
    for (const radio of main.getAllByRole('radio')) await expect(radio).toBeDisabled();
    await expect(canvas.getByLabelText('Preference reads')).toHaveTextContent('1');
    await userEvent.click(canvas.getByRole('button', { name: 'Install fresh explicit token' }));
    await userEvent.click(main.getByRole('radio', { name: new RegExp(m.settings_spoiler_1_title()) }));
    await expect(canvas.getByLabelText('Preference dispatches')).toHaveTextContent('1');
    await expect(canvas.getByLabelText('Last explicit token')).toHaveTextContent('fresh-story-token');
  },
};
