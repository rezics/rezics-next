import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { VerificationCard } from '../../settings/verification';
import {
  VerificationReadError,
  type AgentVerificationRequest,
  type VerificationInput,
} from '../../settings/verification-core';
import { useSettingsAmbient } from '../../settings/adapters/ambient-view.tsx';
import { VerificationRecovery } from '../../settings/verification-recovery';

type Scenario =
  | 'request'
  | 'withdraw'
  | 'unavailable'
  | 'astral'
  | 'invalid'
  | 'links'
  | 'request-delay'
  | 'withdraw-delay'
  | 'read-delay';
const astralStatement = '😀'.repeat(2000);
const boundaryLink = {
  label: '😀'.repeat(64),
  url: 'HTTPS://example.test/' + '😀'.repeat(2048 - 'HTTPS://example.test/'.length),
};
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

function Example({
  scenario = 'request',
  onRequest,
  withDraft = false,
}: {
  scenario?: Scenario;
  onRequest?: (input: VerificationInput) => void;
  withDraft?: boolean;
}) {
  const withdrawing = scenario === 'withdraw' || scenario === 'withdraw-delay';
  const [client] = useState(() => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'story-csrf' });
    queryClient.setQueryData(['exposure', 'viewer'], ['agent_verification']);
    return queryClient;
  });
  const ambient = useSettingsAmbient();
  const [controller] = useState(() => {
    let current: AgentVerificationRequest | null = withdrawing ? pending : null;
    let original: VerificationInput | { idempotencyKey: string } | null = null;
    const send = async (input: VerificationInput | { idempotencyKey: string }, withdraw: boolean) => {
      const requested =
        'subject' in input
          ? { ...pending, catalogueSubjectId: input.subject, statement: input.statement, links: input.links }
          : pending;
      if (!original) {
        original = input;
        current = withdraw ? { ...pending, state: 'withdrawn' } : requested;
        throw new Error('Response lost after native command');
      }
      if (input !== original) throw new Error('Retry changed the original command');
      if (scenario === 'request-delay' || scenario === 'withdraw-delay')
        return {
          ok: false as const,
          status: 503,
          message: 'Native command temporarily unavailable',
          code: 'overloaded',
          retryable: true,
          requestId: 'native-command-retry',
          retryAfter: '3600',
        };
      current = withdraw ? { ...pending, state: 'withdrawn' } : { ...requested, state: 'approving' };
      return { ok: true as const, verificationRequest: withdraw ? current : requested };
    };
    return new VerificationRecovery(
      'alice',
      {
        read: async (accountId) => {
          if (scenario === 'unavailable' && original) throw new Error('Native status unavailable');
          if (scenario === 'read-delay' && original)
            throw new VerificationReadError({
              status: 503,
              message: 'Native current status temporarily unavailable',
              code: 'overloaded',
              retryable: true,
              requestId: 'native-read-retry',
              retryAfter: '3600',
            });
          return {
            accountId,
            verificationRequest: current,
            viewerActions: current
              ? current.state === 'pending'
                ? [{ action: 'account:update', operations: ['account.withdraw_verification'] }]
                : ['withdrawn', 'failed', 'rejected'].includes(current.state)
                  ? [{ action: 'account:update', operations: ['account.request_verification'] }]
                  : []
              : [{ action: 'account:update', operations: ['account.request_verification'] }],
            subjectTitle: 'Avery',
          };
        },
        request: (_, input) => {
          onRequest?.(input);
          return send(input, false);
        },
        withdraw: (_, input) => send(input, true),
      },
      ambient,
    );
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
            withdrawing && !withDraft
              ? undefined
              : {
                  selected: { id: 'subject-1', title: 'Avery', type: m.settings_verification_person() },
                  statement:
                    scenario === 'astral'
                      ? astralStatement
                      : scenario === 'invalid'
                        ? astralStatement + '😀'
                        : pending.statement,
                  links:
                    scenario === 'astral'
                      ? [{ ...boundaryLink }]
                      : scenario === 'invalid'
                        ? [{ label: '😀'.repeat(65), url: 'https://user:password@example.test/Original' }]
                        : scenario === 'links'
                          ? Array.from({ length: 5 }, (_, index) => ({
                              label: '  Same label  ',
                              url: `https://example.test/${index + 1}?value=%2f#Original`,
                            }))
                          : pending.links.map((link) => ({ ...link })),
                }
          }
        />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Account/Verification recovery',
  id: 'patterns-account-verification-recovery',
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
  args: { scenario: 'withdraw', withDraft: true },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.settings_verification_withdraw() }));
    await view.findByText(m.settings_verification_confirm_title());
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_read_current() }));
    await waitFor(() => expect(view.queryByText(m.settings_verification_confirm_title())).toBeNull());
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_withdraw() }));
    await view.findByText(m.settings_verification_confirm_title());
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_change_subject() }));
    await expect(view.queryByText(m.settings_verification_confirm_title())).toBeNull();
    await expect(view.getByRole('combobox')).toHaveValue('');
    await expect(view.getByRole('textbox', { name: m.settings_verification_statement() })).toHaveValue(
      pending.statement,
    );
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_withdraw() }));
    await expect(view.queryByText(m.settings_verification_withdrawn())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_confirm_withdraw() }));
    await view.findByText(m.settings_verification_uncertain_withdraw());
    await expect(view.queryByText(m.settings_verification_withdrawn())).toBeNull();
    await expect(view.getByText(m.settings_verification_withdraw_action({ subject: 'Avery' }))).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_retry_withdraw() }));
    await view.findByText(m.settings_verification_withdrawn());
    await expect(view.queryByRole('button', { name: m.settings_verification_retry_withdraw() })).toBeNull();
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

export const AstralBoundary: Story = {
  args: { scenario: 'astral', onRequest: fn() },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const submit = await view.findByRole('button', { name: m.settings_verification_submit() });
    await expect(submit).toBeEnabled();
    const statement = view.getByRole('textbox', { name: m.settings_verification_statement() });
    const url = view.getByRole('textbox', { name: m.settings_verification_link_url() });
    await expect(statement).toHaveValue(astralStatement);
    await expect(view.getByText(m.settings_verification_characters({ count: 2000 }))).toBeVisible();
    await expect(view.getByLabelText(m.settings_verification_link_label())).toHaveValue(boundaryLink.label);
    await expect(url).toHaveValue(boundaryLink.url);
    await userEvent.click(submit);
    await view.findByText(m.settings_verification_uncertain_request());
    await expect(args.onRequest).toHaveBeenCalledTimes(1);
    await expect(args.onRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: 'subject-1',
        statement: astralStatement,
        links: [boundaryLink],
      }),
    );
    await userEvent.click(statement);
    await userEvent.keyboard('{Control>}{End}{/Control}x');
    await expect(statement).toHaveValue(astralStatement + 'x');
    await expect(view.getByText(m.settings_verification_characters({ count: 2001 }))).toBeVisible();
    await userEvent.clear(url);
    await userEvent.type(url, 'https://user@example.test/later');
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_retry_original() }));
    await view.findByText(m.settings_verification_draft_preserved());
    await expect(args.onRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        subject: 'subject-1',
        statement: astralStatement,
        links: [boundaryLink],
      }),
    );
    await expect(statement).toHaveValue(astralStatement + 'x');
    await expect(url).toHaveValue('https://user@example.test/later');
    await expect(view.queryByText(m.settings_verification_verified())).toBeNull();
  },
};

export const InvalidDraftBeforeCommand: Story = {
  args: { scenario: 'invalid', onRequest: fn() },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const submit = await view.findByRole('button', { name: m.settings_verification_submit() });
    await expect(submit).toBeEnabled();
    const statement = view.getByLabelText(m.settings_verification_statement());
    const label = view.getByLabelText(m.settings_verification_link_label());
    const url = view.getByLabelText(m.settings_verification_link_url());
    await userEvent.click(submit);
    await view.findByText(m.settings_verification_fix_fields());
    await expect(statement).toHaveFocus();
    await expect(statement).toHaveAttribute('aria-invalid', 'true');
    await expect(statement).toHaveAccessibleDescription(
      `${m.settings_verification_characters({ count: 2001 })} ${m.settings_verification_statement_limit()}`,
    );
    await expect(statement).toHaveValue(astralStatement + '😀');
    await expect(label).toHaveValue('😀'.repeat(65));
    await expect(url).toHaveValue('https://user:password@example.test/Original');
    await userEvent.click(
      view.getByRole('link', {
        name: m.settings_verification_link_issue({ number: 1, message: m.settings_verification_label_limit() }),
      }),
    );
    await expect(label).toHaveFocus();
    await expect(label).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(statement);
    await userEvent.type(statement, 'This is my public profile.');
    await userEvent.clear(label);
    await userEvent.type(label, '  Original label  ');
    await userEvent.click(submit);
    await expect(url).toHaveFocus();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(url);
    await userEvent.type(url, ' https://example.test/ ');
    await userEvent.click(submit);
    await expect(url).toHaveValue(' https://example.test/ ');
    await expect(args.onRequest).not.toHaveBeenCalled();
    await expect(view.queryByText(m.settings_verification_uncertain_request())).toBeNull();
    await expect(view.queryByRole('button', { name: m.settings_verification_retry_original() })).toBeNull();
    await expect(submit).toBeEnabled();
  },
};

export const FiveLinkKeyboardEditing: Story = {
  args: { scenario: 'links', onRequest: fn() },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const submit = await view.findByRole('button', { name: m.settings_verification_submit() });
    await expect(submit).toBeEnabled();
    const row = (number: number) => view.getByRole('group', { name: m.settings_verification_link_number({ number }) });
    const labelIn = (group: HTMLElement) => within(group).getByLabelText(m.settings_verification_link_label());
    const urlIn = (group: HTMLElement) => within(group).getByLabelText(m.settings_verification_link_url());
    const remove = (number: number) =>
      view.getByRole('button', { name: m.settings_verification_remove_numbered_link({ number }) });
    await expect(view.getAllByLabelText(m.settings_verification_link_label())).toHaveLength(5);
    await expect(view.getAllByLabelText(m.settings_verification_link_url())).toHaveLength(5);
    await expect(view.queryByRole('button', { name: m.settings_verification_add_link() })).toBeNull();
    const firstLabel = labelIn(row(1));
    const firstUrl = urlIn(row(1));
    const next = row(4);
    const nextLabel = labelIn(next);
    const nextId = nextLabel.id;
    await userEvent.click(urlIn(row(3)));
    await userEvent.tab();
    await expect(remove(3)).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(nextLabel).toHaveFocus();
    await expect(row(3)).toBe(next);
    await expect(nextLabel.id).toBe(nextId);
    await expect(labelIn(row(1))).toBe(firstLabel);
    await expect(firstUrl).toHaveValue('https://example.test/1?value=%2f#Original');
    await userEvent.click(remove(4));
    await expect(nextLabel).toHaveFocus();
    while (view.queryByRole('button', { name: m.settings_verification_remove_numbered_link({ number: 1 }) })) {
      await userEvent.click(remove(1));
    }
    const add = view.getByRole('button', { name: m.settings_verification_add_link() });
    await expect(add).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(labelIn(row(1))).toHaveFocus();
    await expect(labelIn(row(1)).id).not.toBe(firstLabel.id);
    const expectedLinks = Array.from({ length: 5 }, (_, index) => ({
      label: '  Same label  ',
      url: `HTTPS://example.test/${index + 1}?value=%2f#Original`,
    }));
    for (let number = 1; number <= 5; number++) {
      if (number > 1) {
        await userEvent.click(view.getByRole('button', { name: m.settings_verification_add_link() }));
        await expect(labelIn(row(number))).toHaveFocus();
      }
      await userEvent.keyboard(expectedLinks[number - 1]!.label);
      await userEvent.tab();
      await expect(urlIn(row(number))).toHaveFocus();
      await userEvent.keyboard(expectedLinks[number - 1]!.url);
    }
    await expect(view.getAllByLabelText(m.settings_verification_link_label())).toHaveLength(5);
    await expect(view.getAllByLabelText(m.settings_verification_link_url())).toHaveLength(5);
    await userEvent.click(submit);
    await view.findByText(m.settings_verification_uncertain_request());
    await expect(args.onRequest).toHaveBeenCalledTimes(1);
    await expect(args.onRequest).toHaveBeenCalledWith(expect.objectContaining({ links: expectedLinks }));
  },
};

async function showRetryAfter(canvasElement: HTMLElement, withdraw = false) {
  const view = within(canvasElement);
  const retryLabel = withdraw ? m.settings_verification_retry_withdraw() : m.settings_verification_retry_original();
  if (withdraw) {
    await userEvent.click(await view.findByRole('button', { name: m.settings_verification_withdraw() }));
    await userEvent.click(view.getByRole('button', { name: m.settings_verification_confirm_withdraw() }));
  } else {
    const submit = await view.findByRole('button', { name: m.settings_verification_submit() });
    await waitFor(() => expect(submit).toBeEnabled());
    await userEvent.click(submit);
  }
  await view.findByText(
    withdraw ? m.settings_verification_uncertain_withdraw() : m.settings_verification_uncertain_request(),
  );
  await userEvent.click(view.getByRole('button', { name: retryLabel }));
  await view.findByText(m.settings_retry_wait());
  await expect(view.getByRole('button', { name: m.settings_verification_read_current() })).toBeDisabled();
  await expect(view.getByRole('button', { name: retryLabel })).toBeDisabled();
  if (!withdraw) {
    await userEvent.click(view.getByText(m.settings_verification_original()));
    const statement = view.getByRole('textbox', { name: m.settings_verification_statement() });
    await expect(statement).toBeEnabled();
    await userEvent.clear(statement);
    await userEvent.type(statement, 'Later draft while waiting');
    await expect(statement).toHaveValue('Later draft while waiting');
    await expect(view.getByText(pending.statement, { selector: 'p' })).toBeVisible();
    await expect(view.getByRole('button', { name: m.settings_verification_add_link() })).toBeEnabled();
  } else {
    await expect(view.getByText(m.settings_verification_withdraw_action({ subject: 'Avery' }))).toBeVisible();
    await userEvent.click(view.getByText(m.settings_verification_withdraw_details()));
    await expect(view.getByText(pending.id)).toBeVisible();
  }
  await expect(view.queryByText(m.settings_verification_draft_preserved())).toBeNull();
}

export const RequestRetryAfter: Story = {
  args: { scenario: 'request-delay' },
  play: ({ canvasElement }) => showRetryAfter(canvasElement),
};

export const WithdrawalRetryAfter: Story = {
  args: { scenario: 'withdraw-delay' },
  play: ({ canvasElement }) => showRetryAfter(canvasElement, true),
};

export const CurrentReadRetryAfter: Story = {
  args: { scenario: 'read-delay' },
  play: ({ canvasElement }) => showRetryAfter(canvasElement),
};
