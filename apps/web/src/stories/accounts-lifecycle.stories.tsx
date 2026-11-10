import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { AccountLifecyclePage } from '../accounts/lifecycle-controls/page';
import type { Intent, Outcome, Page } from '../accounts/lifecycle-controls/data';
import { m } from '../paraglide/messages.js';

// Illustrative responses exercise presentation and local recovery, not installed native capability.
const ready: Extract<Page, { status: 'ready' }> = {
  status: 'ready',
  account: {
    id: '01a1a000-0000-7000-8000-000000000101',
    kind: 'actor',
    displayName: 'Avery Reader',
    handle: 'avery',
  },
  offered: ['suspend', 'reinstate'],
  currentState: 'unavailable',
};
const privateReason = '  Private review reason\nKeep this exact wording.  ';
const receiptId = '01a1a000-0000-7000-8000-000000000102';
const meta = {
  title: 'Account/Lifecycle',
  id: 'pages-account-lifecycle',
  component: AccountLifecyclePage,
  parameters: {
    layout: 'padded',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
  args: {
    initial: ready,
    io: {
      read: fn(async (): Promise<Page> => ready),
      change: fn(async (_intent: Intent): Promise<Outcome> => ({ status: 'refused', current: ready })),
    },
  },
} satisfies Meta<typeof AccountLifecyclePage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function review(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText(m.lifecycle_reason()), privateReason);
  await userEvent.click(canvas.getByRole('button', { name: m.lifecycle_review() }));
  const confirmation = within(canvas.getByRole('region', { name: m.lifecycle_confirmation() }));
  await expect(confirmation.getByText('Avery Reader')).toBeVisible();
  await expect(confirmation.getByText('@avery')).toBeVisible();
  await expect(confirmation.getByText(m.lifecycle_reason()).nextElementSibling).toHaveTextContent(
    /Private review reason/,
  );
  expect(confirmation.getByText(m.lifecycle_reason()).nextElementSibling?.textContent).toBe(privateReason);
  await expect(confirmation.getByText(ready.account.id)).not.toBeVisible();
  await userEvent.click(confirmation.getByText(m.lifecycle_identity_details()));
  await expect(confirmation.getByText(m.lifecycle_account_id())).toBeVisible();
  await expect(confirmation.getByText(ready.account.id)).toBeVisible();
  return { canvas, confirmation };
}

export const ReviewConfirmation: Story = {
  play: async ({ canvasElement, args }) => {
    const { canvas, confirmation } = await review(canvasElement);
    await expect(confirmation.getByText(m.lifecycle_suspend())).toBeVisible();
    await expect(confirmation.getByText(m.lifecycle_suspend_effect())).toBeVisible();
    expect(args.io.change).not.toHaveBeenCalled();
    await userEvent.click(confirmation.getByRole('button', { name: m.lifecycle_cancel() }));
    await expect(canvas.getByLabelText(m.lifecycle_reason())).toHaveValue(privateReason);
    await expect(canvas.getByRole('button', { name: m.lifecycle_review() })).toBeEnabled();
  },
};
export const ReviewReinstatement: Story = {
  args: { initial: { ...ready, offered: ['reinstate'] } },
  play: async ({ canvasElement }) => {
    const { confirmation } = await review(canvasElement);
    await expect(confirmation.getByText(m.lifecycle_reinstate())).toBeVisible();
    await expect(confirmation.getByText(m.lifecycle_reinstate_effect())).toBeVisible();
  },
};
export const RecordedRequest: Story = {
  args: {
    io: {
      read: fn(async (): Promise<Page> => ({ status: 'missing' })),
      change: fn(async (_intent: Intent): Promise<Outcome> => ({ status: 'recorded', receiptId, current: ready })),
    },
  },
  play: async ({ canvasElement, args }) => {
    const { canvas, confirmation } = await review(canvasElement);
    await userEvent.click(confirmation.getByRole('button', { name: m.lifecycle_confirm() }));
    await expect(await canvas.findByText(m.lifecycle_recorded())).toBeVisible();
    await expect(confirmation.getByText(m.lifecycle_locked())).toBeVisible();
    expect(canvas.queryByRole('button', { name: m.lifecycle_confirm() })).toBeNull();
    expect(canvas.queryByRole('button', { name: m.lifecycle_retry_same() })).toBeNull();
    await userEvent.click(confirmation.getByText(m.lifecycle_operation_details()));
    await expect(confirmation.getByText(receiptId)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.lifecycle_read_current() }));
    await expect(await canvas.findByText(m.lifecycle_missing())).toBeVisible();
    await expect(canvas.getByText(m.lifecycle_recorded())).toBeVisible();
    await expect(confirmation.getByText('Avery Reader')).toBeVisible();
    expect(args.io.change).toHaveBeenCalledTimes(1);
  },
};
export const UnknownResponse: Story = {
  args: {
    io: {
      read: fn(async (): Promise<Page> => ({
        ...ready,
        account: { ...ready.account, displayName: 'Avery Renamed', handle: 'avery-new' },
      })),
      change: fn(async (_intent: Intent): Promise<Outcome> => ({
        status: 'denied',
        current: { status: 'denied' },
      })).mockResolvedValueOnce({ status: 'uncertain', current: { status: 'unavailable' } }),
    },
  },
  play: async ({ canvasElement, args }) => {
    const { canvas, confirmation } = await review(canvasElement);
    await userEvent.click(confirmation.getByRole('button', { name: m.lifecycle_confirm() }));
    await expect(await canvas.findByText(m.lifecycle_uncertain())).toBeVisible();
    const retry = canvas.getByRole('button', { name: m.lifecycle_retry_same() });
    await expect(retry).toBeDisabled();
    expect(args.io.change).toHaveBeenCalledTimes(1);
    await userEvent.click(canvas.getByRole('button', { name: m.lifecycle_read_current() }));
    await expect(await canvas.findByText('Avery Renamed')).toBeVisible();
    await expect(confirmation.getByText('Avery Reader')).toBeVisible();
    await expect(confirmation.getByText('@avery')).toBeVisible();
    expect(confirmation.queryByText('Avery Renamed')).toBeNull();
    await expect(retry).toBeEnabled();
    expect(args.io.read).toHaveBeenCalledTimes(1);
    await userEvent.click(retry);
    await waitFor(() => expect(args.io.change).toHaveBeenCalledTimes(2));
    const calls = (args.io.change as ReturnType<typeof fn>).mock.calls;
    expect(calls[1]![0]).toBe(calls[0]![0]);
    expect(calls[0]![0]).toMatchObject({ accountId: ready.account.id, action: 'suspend', reason: privateReason });
    // A later denial does not settle the original lost response or enable a replacement operation.
    await expect(canvas.getByText(m.lifecycle_uncertain())).toBeVisible();
    await expect(retry).toBeDisabled();
    expect(canvas.queryByRole('button', { name: m.lifecycle_review() })).toBeNull();
    expect(canvas.queryByRole('button', { name: m.lifecycle_cancel() })).toBeNull();
  },
};
export const RequestNotApplied: Story = {
  args: {
    io: {
      read: fn(async (): Promise<Page> => ready),
      change: fn(async (_intent: Intent): Promise<Outcome> => ({ status: 'conflict', current: ready })),
    },
  },
  play: async ({ canvasElement }) => {
    const { canvas, confirmation } = await review(canvasElement);
    await userEvent.click(confirmation.getByRole('button', { name: m.lifecycle_confirm() }));
    await expect(await canvas.findByRole('heading', { name: m.lifecycle_not_applied() })).toBeVisible();
    await expect(canvas.getByText(m.lifecycle_conflict())).toBeVisible();
    await expect(canvas.getByLabelText(m.lifecycle_reason())).toHaveValue(privateReason);
    await expect(canvas.getByRole('button', { name: m.lifecycle_review() })).toBeEnabled();
    expect(canvas.queryByRole('region', { name: m.lifecycle_confirmation() })).toBeNull();
  },
};
export const PendingEffects: Story = {
  args: {
    io: {
      read: fn(async (): Promise<Page> => ready),
      change: fn(async (_intent: Intent): Promise<Outcome> => ({ status: 'pending', current: ready })),
    },
  },
  play: async ({ canvasElement }) => {
    const { canvas, confirmation } = await review(canvasElement);
    await userEvent.click(confirmation.getByRole('button', { name: m.lifecycle_confirm() }));
    await expect(await canvas.findByText(m.lifecycle_pending())).toBeVisible();
    await expect(confirmation.getByText(m.lifecycle_locked())).toBeVisible();
    expect(canvas.queryByRole('button', { name: m.lifecycle_retry_same() })).toBeNull();
  },
};
export const HandleOnly: Story = { args: { initial: { ...ready, account: { ...ready.account, displayName: null } } } };
export const NameUnavailable: Story = {
  args: { initial: { ...ready, account: { ...ready.account, displayName: null, handle: null } } },
};
export const NoAdvertisedAction: Story = { args: { initial: { ...ready, offered: [] } } };
export const MissingTarget: Story = { args: { initial: { status: 'missing' } } };
export const DeniedTarget: Story = { args: { initial: { status: 'denied' } } };
export const Unavailable: Story = { args: { initial: { status: 'unavailable' } } };
