import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { CreatorPaymentAttestationFormView } from '../checkout/creator-payment-attestation-form';
import {
  CreatorPaymentAttempt,
  type PaymentAttestationInput,
  type PaymentAttestationResult,
} from '../checkout/creator-payment-attestation-state';
import type { CreatorStatement } from '../checkout/creator-statements';
import { CreatorStatementPage } from '../checkout/creator-statement-page';
import {
  creatorLineFixture,
  creatorStatementFixture,
  historicalCreatorLineFixture,
  historicalCreatorStatementFixture,
} from '../kernel/fake/creator-statements';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory, pageReady } from './page';

const meta = {
  title: 'Patterns/Commerce/Creator Payment Attestation',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'These interactions inventory the real attestation form and reducer with typed command outcomes. They are not native recordings; Web captures screenshots after integration.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type Outcome = 'saved' | 'uncertain' | 'denied' | 'conflict' | 'rejected' | 'pending';

function response(outcome: Outcome, input: PaymentAttestationInput): Promise<PaymentAttestationResult> {
  if (outcome === 'pending') return new Promise(() => {});
  if (outcome === 'saved')
    return Promise.resolve({
      kind: 'saved',
      statement: {
        id: input.statementId,
        state: 'paid',
        paidAt: '2026-11-03T10:00:00Z',
        paidReference: input.paidReference,
        revision: creatorStatementFixture.revision + 1,
      },
    });
  return Promise.resolve({ kind: outcome });
}

function CreatorPaymentScenario({
  statement = creatorStatementFixture,
  outcomes,
  retireControl = false,
}: {
  statement?: CreatorStatement;
  outcomes: Outcome[];
  retireControl?: boolean;
}) {
  const subject = statement.creatorAccountId;
  const [attempt] = useState(() => new CreatorPaymentAttempt(statement.id, subject));
  const [reference, setReference] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [authorityRevision, updateAuthority] = useState(0);
  const authority = useRef(true);
  const dispatch = useRef(0);
  void authorityRevision;
  const isCurrent = () => authority.current;
  const execute = (input: PaymentAttestationInput) => {
    const outcome = outcomes[Math.min(dispatch.current++, outcomes.length - 1)] ?? 'uncertain';
    return response(outcome, input);
  };

  async function refreshEvidence() {
    if (!isCurrent() || refreshing) return;
    setRefreshing(true);
    await Promise.resolve();
    if (!isCurrent()) return;
    setRefreshFailed(true);
    setRefreshing(false);
  }

  async function submit() {
    if (terminal(attempt)) return;
    await attempt.submit(reference, execute, isCurrent);
    if (isCurrent() && attempt.result?.kind === 'saved') await refreshEvidence();
  }

  return (
    <>
      <CreatorPaymentAttestationFormView
        statement={statement}
        locale={getLocale()}
        attempt={attempt}
        reference={reference}
        onReferenceChange={(value) => {
          setReference(value);
          attempt.setCorrectionDraft(value);
        }}
        admitted={isCurrent()}
        isCurrent={isCurrent}
        onSubmit={submit}
        onRefresh={refreshEvidence}
        refreshing={refreshing}
        refreshFailed={refreshFailed}
      />
      {retireControl && (
        <button
          type="button"
          className="min-h-11 rounded-md border px-4 text-sm"
          onClick={() => {
            authority.current = false;
            updateAuthority((version) => version + 1);
          }}
        >
          Retire current authority (story control)
        </button>
      )}
    </>
  );
}

function terminal(attempt: CreatorPaymentAttempt) {
  return attempt.result?.kind === 'saved' || attempt.result?.kind === 'conflict';
}

function render({
  outcomes = [],
  statement = creatorStatementFixture,
  retireControl = false,
}: {
  outcomes?: Outcome[];
  statement?: CreatorStatement;
  retireControl?: boolean;
} = {}) {
  const line =
    statement.id === historicalCreatorStatementFixture.id ? historicalCreatorLineFixture : creatorLineFixture;
  return (
    <PatternStory visitor="Signed In" path={`/creator/statements/${statement.id}`}>
      <AppShell>
        <CreatorStatementPage
          id={statement.id}
          locale={getLocale()}
          page={{
            kind: 'ready',
            statement,
            lines: {
              kind: 'ready',
              lines: [{ ...line, statementId: statement.id, period: statement.period }],
              next: null,
            },
          }}
          payment={<CreatorPaymentScenario statement={statement} outcomes={outcomes} retireControl={retireControl} />}
        />
      </AppShell>
    </PatternStory>
  );
}

function main(context: { canvasElement: HTMLElement }) {
  return within(within(context.canvasElement).getByRole('main'));
}

async function enterReference(view: ReturnType<typeof main>, value = 'BANK/September 2026') {
  const field = view.getByRole('textbox', { name: m.statements_paid_reference() });
  await userEvent.type(field, value);
  return field;
}

export const Editing: Story = {
  render: () => render(),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    const field = await enterReference(view);
    await expect(field).toHaveValue('BANK/September 2026');
    await expect(view.getByRole('button', { name: m.payment_attestation_submit() })).toBeEnabled();
    await expect(view.getByText(m.statements_accounting_note())).toBeVisible();
  },
};

export const FirstValidationRejection: Story = {
  render: () => render({ outcomes: ['rejected'] }),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    await enterReference(view);
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_submit() }));
    await expect(await view.findByText(m.payment_attestation_correction_available())).toBeVisible();
    await expect(view.getByRole('button', { name: m.payment_attestation_correction_edit() })).toBeVisible();
  },
};

export const ReferenceCorrectionResubmission: Story = {
  render: () => render({ outcomes: ['rejected', 'saved'] }),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    const field = await enterReference(view);
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_submit() }));
    await view.findByText(m.payment_attestation_correction_available());
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_correction_edit() }));
    await userEvent.clear(field);
    await userEvent.type(field, 'BANK/Corrected September 2026');
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_correction_submit() }));
    await expect(await view.findByText(m.payment_attestation_saved())).toBeVisible();
    await expect(view.getByText('BANK/Corrected September 2026', { exact: true })).toBeVisible();
  },
};

export const Pending: Story = {
  render: () => render({ outcomes: ['pending'] }),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    await enterReference(view);
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_submit() }));
    await expect(await view.findByText(m.payment_attestation_submitting())).toBeVisible();
  },
};

export const UncertainOriginalRetry: Story = {
  render: () => render({ outcomes: ['uncertain', 'saved'] }),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    const field = await enterReference(view);
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_submit() }));
    await view.findByText(m.payment_attestation_uncertain());
    const originalKey = view.getByText(m.payment_attestation_request()).nextElementSibling?.textContent;
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_retry() }));
    await expect(await view.findByText(m.payment_attestation_saved())).toBeVisible();
    await expect(field).toHaveValue('BANK/September 2026');
    await expect(view.getByText(m.payment_attestation_request()).nextElementSibling).toHaveTextContent(originalKey!);
  },
};

export const ConflictWithRefresh: Story = {
  render: () => render({ outcomes: ['conflict'] }),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    await enterReference(view);
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_submit() }));
    await expect(await view.findByText(m.payment_attestation_conflict())).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.statements_refresh() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.payment_attestation_refresh_failed());
    await expect(view.queryByRole('button', { name: m.payment_attestation_retry() })).toBeNull();
  },
};

export const DeniedRetiredAuthority: Story = {
  render: () => render({ outcomes: ['denied'], retireControl: true }),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    await enterReference(view);
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_submit() }));
    await expect(await view.findByText(m.creator_denied())).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: 'Retire current authority (story control)' }));
    await expect(view.getByRole('textbox', { name: m.statements_paid_reference() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.payment_attestation_retry() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.statements_refresh() })).toBeDisabled();
  },
};

export const ConfirmedSavedEvidence: Story = {
  render: () => render({ outcomes: ['saved'] }),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    await enterReference(view);
    await userEvent.click(view.getByRole('button', { name: m.payment_attestation_submit() }));
    await expect(await view.findByText(m.payment_attestation_saved())).toBeVisible();
    await expect(view.getByText('BANK/September 2026', { exact: true })).toBeVisible();
    await expect(view.getByText(m.statements_funds_unknown())).toBeVisible();
    await expect(await view.findByRole('alert')).toHaveTextContent(m.payment_attestation_refresh_failed());
  },
};

export const HistoricalUnknownMoney: Story = {
  render: () => render({ statement: historicalCreatorStatementFixture }),
  play: async (context) => {
    await pageReady(context);
    const view = main(context);
    await expect(await view.findByText(m.statements_amount_unavailable())).toBeVisible();
    await expect(view.getByText(historicalCreatorStatementFixture.paidReference!)).toBeVisible();
    await expect(view.getByText(m.statements_payment_meaning())).toBeVisible();
    await expect(view.queryByRole('button', { name: m.payment_attestation_submit() })).toBeNull();
  },
};
