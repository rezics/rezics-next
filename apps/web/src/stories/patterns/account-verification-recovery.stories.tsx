import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { VerificationCard } from '../../settings/verification';
import type { AgentVerificationRequest, VerificationInput } from '../../settings/verification-core';
import { VerificationRecovery } from '../../settings/verification-recovery';

type Scenario = 'request' | 'withdraw' | 'unavailable';
const pending: AgentVerificationRequest = {
  id: 'request-1',
  accountId: 'alice',
  accountKind: 'actor',
  requestedBy: 'alice',
  catalogueSubjectId: 'subject-1',
  statement: 'This is me.',
  links: [{ label: 'Homepage', url: 'https://example.test' }],
  state: 'pending',
  reason: null,
  problem: null,
  decisionReceiptId: null,
  decidedBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function Example({ scenario = 'request' }: { scenario?: Scenario }) {
  const [client] = useState(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'story-csrf' });
    queryClient.setQueryData(['exposure', 'viewer'], ['agent_verification']);
    return queryClient;
  });
  const [controller] = useState(() => {
    let current: AgentVerificationRequest | null = scenario === 'withdraw' ? pending : null;
    let original: VerificationInput | { idempotencyKey: string } | null = null;
    const send = async (input: VerificationInput | { idempotencyKey: string }, withdraw: boolean) => {
      if (!original) {
        original = input;
        current = withdraw ? { ...pending, state: 'withdrawn' } : pending;
        throw new Error('Response lost after native command');
      }
      if (input !== original) throw new Error('Retry changed the original command');
      current = withdraw ? { ...pending, state: 'withdrawn' } : { ...pending, state: 'approving' };
      return { ok: true as const, verificationRequest: withdraw ? current : pending };
    };
    return new VerificationRecovery('alice', {
      read: async (accountId) => {
        if (scenario === 'unavailable' && original) throw new Error('Native status unavailable');
        return { accountId, verificationRequest: current, subjectTitle: 'Avery' };
      },
      request: (_, input) => send(input, false),
      withdraw: (_, input) => send(input, true),
    });
  });
  useEffect(() => {
    controller.activate();
    void controller.reload();
    return () => controller.deactivate();
  }, [controller]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-2xl">
        <VerificationCard
          controller={controller}
          csrfToken="story-csrf"
          initialDraft={
            scenario === 'withdraw'
              ? undefined
              : {
                  selected: { id: 'subject-1', title: 'Avery', type: m.settings_verification_person() },
                  statement: pending.statement,
                  links: pending.links.map((link) => ({ ...link })),
                }
          }
        />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Patterns/Account/Verification recovery',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The settings verification card and in-memory controller, using explicit native-shaped interface fixtures. Pending and approving remain native states. Native, browser and visual proof is deferred to integration. Use the shared phone390 and desktop1280 viewports.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RequestLostResponse: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const submit = await view.findByRole('button', { name: m.settings_verification_submit() });
    await expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await view.findByText(m.settings_verification_uncertain_request());
    const statement = view.getByRole('textbox', { name: m.settings_verification_statement() });
    await userEvent.clear(statement);
    await userEvent.type(statement, 'Later draft');
    const url = view.getByRole('textbox', { name: m.settings_verification_link_url() });
    await userEvent.clear(url);
    await userEvent.type(url, 'https://example.test/later');
    for (let index = 1; index < 5; index++) {
      await userEvent.click(view.getByRole('button', { name: m.settings_verification_add_link() }));
      await userEvent.type(
        view.getAllByRole('textbox', { name: m.settings_verification_link_label() })[index]!,
        `Later ${index}`,
      );
      await userEvent.type(
        view.getAllByRole('textbox', { name: m.settings_verification_link_url() })[index]!,
        `https://example.test/${index}`,
      );
    }
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_read_current() }));
    await view.findByText(m.settings_verification_pending({ subject: 'Avery' }));
    await expect(view.getByRole('button', { name: m.settings_verification_retry_original() })).toBeEnabled();
    await expect(submit).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_retry_original() }));
    await view.findByText(m.settings_verification_draft_preserved());
    await expect(statement).toHaveValue('Later draft');
    await expect(url).toHaveValue('https://example.test/later');
    await expect(view.getAllByRole('textbox', { name: m.settings_verification_link_url() })).toHaveLength(5);
    await expect(view.getByText(`Avery · ${m.settings_verification_person()}`)).toBeVisible();
    await expect(view.queryByText(m.settings_verification_verified())).toBeNull();
    await expect(view.queryByText(m.settings_verification_sent())).toBeNull();
  },
};

export const WithdrawalLostResponse: Story = {
  args: { scenario: 'withdraw' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.settings_verification_withdraw() }));
    await view.findByText(m.settings_verification_confirm_title());
    await expect(view.queryByText(m.settings_verification_withdrawn())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_confirm_withdraw() }));
    await view.findByText(m.settings_verification_uncertain_withdraw());
    await expect(view.queryByText(m.settings_verification_withdrawn())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_retry_original() }));
    await view.findByText(m.settings_verification_withdrawn());
    await expect(view.queryByRole('button', { name: m.settings_verification_retry_original() })).toBeNull();
  },
};

export const ReadUnavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const submit = await view.findByRole('button', { name: m.settings_verification_submit() });
    await expect(submit).toBeEnabled();
    await userEvent.click(submit);
    await view.findByText(m.settings_verification_uncertain_request());
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_retry_original() }));
    await view.findByText(m.settings_verification_uncertain_request());
    await expect(submit).toBeDisabled();
    await expect(view.queryByText(m.settings_verification_sent())).toBeNull();
    await expect(view.queryByText(m.settings_verification_pending({ subject: 'Avery' }))).toBeNull();
    await expect(view.queryByText(m.settings_verification_verified())).toBeNull();
  },
};
