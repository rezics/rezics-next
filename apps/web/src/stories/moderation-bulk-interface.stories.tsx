import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, within } from 'storybook/test';
import { useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import {
  BoardReportQueue,
  type ReportQueueAction,
  type ReportQueueProps,
} from './patterns/board-report-queue/board-report-queue';
import { moderationQueueFixture, postReport, queueViewports } from './patterns/board-report-queue/fixture';

// Existing contract-shaped fixture inputs and public callback outcomes only. All observations
// are authored UNRUN; these examples establish no native admission or browser approval.
const reports = [...moderationQueueFixture.reports, { ...postReport, id: 'illustrative-third-report' }];
const meta = {
  title: 'Patterns/Moderation bulk interface',
  component: BoardReportQueue,
  parameters: {
    layout: 'padded',
    viewport: { options: queueViewports },
    docs: {
      description: {
        component:
          'Actual ReportsBulkControls and refresh-failure receipts through BoardReportQueue. Fixture-derived, UNRUN observations at 390/1280, locale and RTL globals; native, physical and browser acceptance remains owed.',
      },
    },
  },
  args: {
    ...moderationQueueFixture,
    reports,
    queueIdentity: 'illustrative-bulk-visit',
    onAction: fn<ReportQueueAction>(async () => ({ ok: false, state: 'forbidden' })),
  },
  beforeEach: ({ args }) => {
    mocked(args.onAction).mockClear();
    if (args.onRefresh) mocked(args.onRefresh).mockClear();
  },
} satisfies Meta<typeof BoardReportQueue>;
export default meta;
type Story = StoryObj<typeof meta>;

function bulk(canvasElement: HTMLElement) {
  return within(canvasElement).getByRole('article', { name: m.moderation_bulk_title() });
}

async function observeSurface(surface: HTMLElement) {
  await expect(surface.querySelector('details, [hidden]')).toBeNull();
  for (const button of surface.querySelectorAll('button')) {
    await expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await expect(getComputedStyle(button).whiteSpace).toBe('normal');
  }
  for (const element of [surface, ...surface.querySelectorAll('li, p, h2, h3, button')])
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  await expect(surface.getBoundingClientRect().width).toBeLessThanOrEqual(
    surface.ownerDocument.documentElement.clientWidth,
  );
  // Even closed markup and attributes in the bulk region must contain public receipts only.
  for (const report of reports)
    for (const secret of [report.id, report.target.id, report.revisionId, report.evidence])
      if (secret) await expect(surface.outerHTML).not.toContain(secret);
}

async function observeFocus(element: HTMLElement) {
  await expect(element).toHaveFocus();
  const style = getComputedStyle(element);
  await expect(style.outlineStyle).not.toBe('none');
  await expect(Number.parseFloat(style.outlineWidth)).toBeGreaterThanOrEqual(2);
}

async function review(canvasElement: HTMLElement) {
  const view = within(bulk(canvasElement));
  await userEvent.click(view.getByRole('button', { name: m.moderation_bulk_select_loaded() }));
  await userEvent.click(view.getByRole('button', { name: m.moderation_bulk_review() }));
  await expect(view.getByRole('heading', { name: m.moderation_bulk_confirmation({ count: 3 }) })).toBeVisible();
  await observeSurface(bulk(canvasElement));
  return view;
}

async function confirm(canvasElement: HTMLElement) {
  const view = await review(canvasElement);
  await userEvent.click(view.getByRole('button', { name: m.moderation_bulk_confirm({ count: 3 }) }));
  await view.findByRole('status');
  return view;
}

export const SelectingReviewCancel: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement, args }) => {
    const view = within(bulk(canvasElement));
    const select = view.getByRole('button', { name: m.moderation_bulk_select_loaded() });
    await expect(view.getByRole('button', { name: m.moderation_bulk_clear() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.moderation_bulk_review() })).toBeDisabled();
    await observeSurface(bulk(canvasElement));
    select.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await observeFocus(view.getByRole('button', { name: m.moderation_bulk_clear() }));
    await userEvent.keyboard(' ');
    await expect(view.getByText(m.moderation_bulk_selected({ count: 0 }))).toBeVisible();
    select.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await userEvent.tab();
    await observeFocus(view.getByRole('button', { name: m.moderation_bulk_review() }));
    await userEvent.keyboard('{Enter}');
    await observeFocus(view.getByRole('group', { name: m.moderation_bulk_confirmation({ count: 3 }) }));
    await userEvent.tab();
    await observeFocus(view.getByRole('button', { name: m.moderation_bulk_confirm({ count: 3 }) }));
    await userEvent.tab();
    await observeFocus(view.getByRole('button', { name: m.moderation_bulk_cancel() }));
    await userEvent.keyboard(' ');
    await expect(view.getByRole('button', { name: m.moderation_bulk_review() })).toHaveFocus();
    await expect(view.getByText(m.moderation_bulk_selected({ count: 3 }))).toBeVisible();
    await expect(args.onAction).not.toHaveBeenCalled();
  },
};

export const ReviewConfirmation: Story = {
  play: async ({ canvasElement, args }) => {
    await review(canvasElement);
    await expect(args.onAction).not.toHaveBeenCalled();
  },
};

export const PartialResults: Story = {
  args: {
    onAction: fn<ReportQueueAction>(async (command) =>
      command.reportId === reports[0]!.id ? { ok: true } : { ok: false, state: 'forbidden' },
    ),
  },
  play: async ({ canvasElement, args }) => {
    const view = await confirm(canvasElement);
    await expect(await view.findByText(m.moderation_bulk_forbidden(), { exact: false })).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_dismissed(), { exact: false })).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_unattempted(), { exact: false })).toBeVisible();
    await expect(args.onAction).toHaveBeenCalledTimes(2);
    await expect(view.queryByRole('button', { name: m.moderation_bulk_retry() })).toBeNull();
    await observeSurface(bulk(canvasElement));
  },
};

export const UncertainExactRetry: Story = {
  args: {
    onAction: fn<ReportQueueAction>(),
    onRefresh: fn(async () => {
      throw new Error('Illustrative replacement read failure');
    }),
  },
  beforeEach: ({ args }) => {
    mocked(args.onAction)
      .mockReset()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true });
  },
  play: async ({ canvasElement, args }) => {
    const view = await confirm(canvasElement);
    const retry = await view.findByRole('button', { name: m.moderation_bulk_retry() });
    await expect(view.getByText(m.moderation_bulk_uncertain(), { exact: false })).toBeVisible();
    await expect(view.queryByRole('button', { name: m.moderation_bulk_refresh() })).toBeNull();
    await expect(args.onRefresh).not.toHaveBeenCalled();
    await observeSurface(bulk(canvasElement));
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_bulk_stale());
    const calls = mocked(args.onAction).mock.calls;
    await expect(calls).toHaveLength(3);
    await expect(calls[2]![0]).toBe(calls[1]![0]);
    await expect(calls.some(([command]) => command.reportId === reports[2]!.id)).toBe(false);
    await expect(view.getByText(m.moderation_bulk_unattempted(), { exact: false })).toBeVisible();
    await expect(args.onRefresh).toHaveBeenCalledTimes(1);
    await observeSurface(bulk(canvasElement));
    await expect(canvasElement.innerHTML).not.toContain(postReport.evidence!);
  },
};

export const DefinitiveRefusalRefresh: Story = {
  args: { onRefresh: fn(async () => {}) },
  play: async ({ canvasElement, args }) => {
    const view = await confirm(canvasElement);
    const refresh = await view.findByRole('button', { name: m.moderation_bulk_refresh() });
    await observeSurface(bulk(canvasElement));
    refresh.focus();
    await userEvent.keyboard(' ');
    await expect(args.onRefresh).toHaveBeenCalledTimes(1);
    await expect(args.onAction).toHaveBeenCalledTimes(1);
    await expect(canvasElement.innerHTML).not.toContain(postReport.evidence!);
  },
};

export const Running: Story = {
  args: { onAction: fn<ReportQueueAction>(() => new Promise(() => {})) },
  play: async ({ canvasElement, args }) => {
    const view = await confirm(canvasElement);
    await expect(view.getByRole('status')).toHaveTextContent(m.moderation_bulk_running());
    await expect(view.getByText(m.moderation_bulk_pending(), { exact: false })).toBeVisible();
    await expect(view.queryByRole('button')).toBeNull();
    await expect(args.onAction).toHaveBeenCalledTimes(1);
    await observeSurface(bulk(canvasElement));
  },
};

export const RefreshingReceipts: Story = {
  args: {
    ...PartialResults.args,
    onRefresh: fn(() => new Promise<void>(() => {})),
  },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement, args }) => {
    const view = await review(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_bulk_confirm({ count: 3 }) }));
    await expect(await view.findByText(m.moderation_bulk_refreshing())).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_dismissed(), { exact: false })).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_forbidden(), { exact: false })).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_unattempted(), { exact: false })).toBeVisible();
    await expect(view.queryByRole('button')).toBeNull();
    await expect(args.onAction).toHaveBeenCalledTimes(2);
    await expect(args.onRefresh).toHaveBeenCalledTimes(1);
    await observeSurface(bulk(canvasElement));
    await expect(canvasElement.innerHTML).not.toContain(postReport.evidence!);
  },
};

function ReplacementQueue(args: ReportQueueProps) {
  const [state, setState] = useState<'ready' | 'error'>('ready');
  return (
    <BoardReportQueue
      {...args}
      state={state}
      onRefresh={async () => {
        try {
          await args.onRefresh?.();
        } finally {
          setState('error');
        }
      }}
    />
  );
}

export const FailedRefreshReceipts: Story = {
  ...PartialResults,
  args: {
    ...PartialResults.args,
    onRefresh: fn(async () => {
      throw new Error('Illustrative replacement read failure');
    }),
  },
  render: (args) => <ReplacementQueue {...args} />,
  play: async ({ canvasElement, args }) => {
    await review(canvasElement);
    await userEvent.click(
      within(bulk(canvasElement)).getByRole('button', { name: m.moderation_bulk_confirm({ count: 3 }) }),
    );
    const receipt = await within(canvasElement).findByRole('alert', { name: m.moderation_bulk_stale() });
    await observeSurface(receipt);
    await expect(receipt).toHaveTextContent(m.moderation_bulk_dismissed());
    await expect(receipt).toHaveTextContent(m.moderation_bulk_forbidden());
    await expect(receipt).toHaveTextContent(m.moderation_bulk_unattempted());
    await expect(receipt.querySelector('button')).toBeNull();
    await expect(args.onRefresh).toHaveBeenCalledTimes(1);
    await expect(canvasElement.innerHTML).not.toContain(postReport.evidence!);
  },
};

function RetiringQueue(args: ReportQueueProps) {
  const [retired, setRetired] = useState(false);
  return (
    <>
      <Button className="h-auto min-h-11 min-w-11 whitespace-normal py-2" onClick={() => setRetired(true)}>
        Retire fixture visit
      </Button>
      <BoardReportQueue
        {...args}
        {...(retired ? { queueIdentity: 'illustrative-replacement' } : {})}
        state={retired ? 'denied' : 'ready'}
      />
    </>
  );
}

export const RetiredResults: Story = {
  ...PartialResults,
  render: (args) => <RetiringQueue {...args} />,
  play: async ({ canvasElement }) => {
    await confirm(canvasElement);
    await within(bulk(canvasElement)).findByText(m.moderation_bulk_forbidden(), { exact: false });
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Retire fixture visit' }));
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(m.moderation_queue_read_denied());
    await expect(within(canvasElement).queryByRole('article', { name: m.moderation_bulk_title() })).toBeNull();
    await expect(canvasElement.innerHTML).not.toContain(postReport.evidence!);
    await expect(canvasElement.textContent).not.toContain(m.moderation_bulk_results());
  },
};

export const LongLocalizedReview: Story = {
  ...ReviewConfirmation,
  globals: { locale: 'fr', viewport: { value: 'phone390', isRotated: false } },
};
export const LongLocalizedReviewDesktop: Story = {
  ...LongLocalizedReview,
  globals: { locale: 'fr', viewport: { value: 'desktop1280', isRotated: false } },
};
export const LongLocalizedReviewRtl: Story = {
  ...LongLocalizedReview,
  decorators: [
    (Story) => (
      <div dir="rtl">
        <Story />
      </div>
    ),
  ],
};
export const LongLocalizedReviewRtlDesktop: Story = {
  ...LongLocalizedReviewDesktop,
  decorators: [
    (Story) => (
      <div dir="rtl">
        <Story />
      </div>
    ),
  ],
};
export const LongLocalizedUncertain: Story = {
  args: {
    onAction: fn<ReportQueueAction>(async (command) => {
      if (command.reportId === reports[0]!.id) return { ok: true };
      throw new TypeError('Failed to fetch');
    }),
  },
  globals: { locale: 'fr', viewport: { value: 'phone390', isRotated: false } },
  play: async ({ canvasElement }) => {
    const view = await confirm(canvasElement);
    await expect(await view.findByRole('button', { name: m.moderation_bulk_retry() })).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_uncertain(), { exact: false })).toBeVisible();
    await observeSurface(bulk(canvasElement));
  },
};
export const LongLocalizedDesktop: Story = {
  ...LongLocalizedUncertain,
  globals: { locale: 'fr', viewport: { value: 'desktop1280', isRotated: false } },
};
export const LongLocalizedRtlPhone: Story = {
  ...LongLocalizedUncertain,
  decorators: [
    (Story) => (
      <div dir="rtl">
        <Story />
      </div>
    ),
  ],
};
export const LongLocalizedRtlDesktop: Story = {
  ...LongLocalizedDesktop,
  decorators: [
    (Story) => (
      <div dir="rtl">
        <Story />
      </div>
    ),
  ],
};
export const FailedRefreshRtl: Story = {
  ...FailedRefreshReceipts,
  globals: { locale: 'fr', viewport: { value: 'phone390', isRotated: false } },
  decorators: [
    (Story) => (
      <div dir="rtl">
        <Story />
      </div>
    ),
  ],
};
export const FailedRefreshDesktop: Story = {
  ...FailedRefreshReceipts,
  globals: { locale: 'fr', viewport: { value: 'desktop1280', isRotated: false } },
};
export const FailedRefreshRtlDesktop: Story = {
  ...FailedRefreshDesktop,
  decorators: [
    (Story) => (
      <div dir="rtl">
        <Story />
      </div>
    ),
  ],
};
