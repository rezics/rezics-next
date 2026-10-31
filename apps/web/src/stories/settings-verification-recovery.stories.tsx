import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { VerificationCard } from '../settings/verification';
import { VerificationReadError } from '../settings/verification-core';
import { VerificationRecovery } from '../settings/verification-recovery';
import { PatternStory } from './page';

type Scenario = 'empty' | 'failure' | 'recovery';

function CurrentStatusCard({
  accountId,
  csrfToken,
  scenario,
}: {
  accountId: string;
  csrfToken: string | null;
  scenario: Scenario;
}) {
  const [controller] = useState(() => {
    let reads = 0;
    return new VerificationRecovery(accountId, {
      read: async (currentAccountId) => {
        const attempt = ++reads;
        // Illustrative read IO only, consumed by the actual controller and card.
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        if (scenario === 'failure' || (scenario === 'recovery' && attempt === 1))
          throw new VerificationReadError({
            status: 503,
            code: 'dependency_unavailable',
            message: m.settings_unavailable_text(),
            requestId: 'illustrative-status-read',
          });
        return { accountId: currentAccountId, verificationRequest: null, subjectTitle: null };
      },
      request: async () => {
        throw new Error('This status-read story does not send commands');
      },
      withdraw: async () => {
        throw new Error('This status-read story does not send commands');
      },
    });
  });
  useEffect(() => {
    controller.activate();
    void controller.reload();
    return () => controller.deactivate();
  }, [controller]);
  return <VerificationCard controller={controller} csrfToken={csrfToken} />;
}

function CurrentViewer({ scenario }: { scenario: Scenario }) {
  const session = useSession();
  if (session.state !== 'signed-in' || !session.subject) return <p role="status">{m.settings_sections_loading()}</p>;
  return (
    <CurrentStatusCard
      key={JSON.stringify([session.subject, session.csrfToken])}
      accountId={session.subject}
      csrfToken={session.csrfToken}
      scenario={scenario}
    />
  );
}

function Example({ scenario }: { scenario: Scenario }) {
  return (
    <PatternStory visitor="Signed In" path="/settings#verification">
      <div className="mx-auto max-w-2xl">
        <CurrentViewer scenario={scenario} />
      </div>
    </PatternStory>
  );
}

const meta = {
  title: 'Patterns/Account/Verification current status',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The current Settings verification controller and card with illustrative empty, failed and explicitly recovered read IO. Uses the shared story viewer, locale, theme and phone390/desktop1280 globals. No verification command is sent or granted. Stories are unrun; native, runtime, browser and visual proof remain with integration.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectEmpty(view: ReturnType<typeof within>) {
  await waitFor(() => expect(view.getByRole('status')).toHaveTextContent(m.settings_verification_read_empty()));
  await expect(view.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  await expect(view.getByRole('button', { name: m.settings_verification_submit() })).toBeDisabled();
  await expect(view.queryByText(m.settings_verification_sent())).toBeNull();
  await expect(view.queryByText(m.settings_verification_verified())).toBeNull();
}

async function readAgain(view: ReturnType<typeof within>) {
  const read = view.getByRole('button', { name: m.settings_verification_read_current() });
  await userEvent.click(read);
  await expect(read).toBeDisabled();
  await expect(view.getByRole('status')).toHaveTextContent(m.settings_verification_loading());
}

export const CurrentStatusEmpty: Story = {
  args: { scenario: 'empty' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.settings_verification_read_empty());
    await expectEmpty(view);
    const statement = view.getByRole('textbox', { name: m.settings_verification_statement() });
    await userEvent.type(statement, 'Unsent draft');
    await readAgain(view);
    await expectEmpty(view);
    await expect(statement).toHaveValue('Unsent draft');
  },
};

export const CurrentStatusEmptyPhone: Story = {
  ...CurrentStatusEmpty,
  globals: { viewport: { value: 'phone390' } },
};

export const CurrentStatusFailure: Story = {
  args: { scenario: 'failure' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const failure = await view.findByRole('alert');
    await expect(failure).toHaveTextContent(m.settings_verification_load_failed());
    await expect(failure).toHaveAttribute('data-response-status', '503');
    await readAgain(view);
    await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent(m.settings_verification_load_failed()));
    await expect(view.getByRole('button', { name: m.settings_verification_read_current() })).toBeEnabled();
    await expect(view.queryByText(m.settings_verification_read_empty())).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_verification_submit() })).toBeNull();
  },
};

export const CurrentStatusFailurePhone: Story = {
  ...CurrentStatusFailure,
  globals: { viewport: { value: 'phone390' } },
};

export const CurrentStatusRecovered: Story = {
  args: { scenario: 'recovery' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('alert');
    await readAgain(view);
    await expectEmpty(view);
    await expect(view.queryByRole('alert')).toBeNull();
  },
};

export const CurrentStatusRecoveredPhone: Story = {
  ...CurrentStatusRecovered,
  globals: { viewport: { value: 'phone390' } },
};
