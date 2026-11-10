import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ModerationReportsView } from '../moderation/reports-page';
import { DEFAULT_REPORT_SELECTION, type ReportSelection } from '../moderation/reports-read';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { postReport, queueViewports, selectedQueueFixture } from './patterns/board-report-queue/fixture';

const meta = {
  title: 'Community/Moderation queue controls',
  id: 'pages-community-moderation-queue-controls',
  component: ModerationReportsView,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: queueViewports },
    docs: {
      description: {
        component:
          'Supplied illustrative reports in the actual page view. All observations are authored UNRUN; native admission and browser verification remain owed.',
      },
    },
  },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/boards/community/moderation">
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    ...selectedQueueFixture,
    boardId: 'community',
    threadId: 'thread +/雪',
    postId: 'post?&=é',
    next: null,
  },
} satisfies Meta<typeof ModerationReportsView>;
export default meta;
type Story = StoryObj<typeof meta>;

// Authored UNRUN. These observations require a real rendered browser for geometry.
async function observeControls(
  canvasElement: HTMLElement,
  tab: 'reports' | 'appeals' = 'reports',
  selection: ReportSelection = selectedQueueFixture.selection,
) {
  const view = within(canvasElement);
  const heading = await view.findByRole('heading', { name: m.moderation_reports_heading(), level: 1 });
  await expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  const article = heading.closest('article')!;
  const nav = view.getByRole('navigation', { name: m.moderation_tabs_label() });
  const links = within(nav).getAllByRole('link');
  await expect(links).toHaveLength(2);
  await expect(links[0]).toHaveAccessibleName(m.moderation_reports_tab());
  await expect(links[1]).toHaveAccessibleName(m.moderation_appeals_tab());
  await expect(links[0]).toHaveAttribute(
    'href',
    `?thread=thread%20%2B%2F%E9%9B%AA&post=post%3F%26%3D%C3%A9&${new URLSearchParams(selection)}`,
  );
  await expect(links[1]).toHaveAttribute(
    'href',
    '?tab=appeals&thread=thread%20%2B%2F%E9%9B%AA&post=post%3F%26%3D%C3%A9',
  );
  await expect(links[tab === 'reports' ? 0 : 1]).toHaveAttribute('aria-current', 'page');
  await expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  await expect(links[tab === 'reports' ? 0 : 1]).toHaveClass('underline', 'border-primary');
  const back = view.getByRole('link', { name: m.moderation_queue_back() });
  await expect(back).toHaveAttribute('href', `/${getLocale()}/boards/community`);
  const group = view.getByRole('group', { name: m.moderation_filter_label() });
  const selects = [
    view.getByRole('combobox', { name: m.moderation_filter_status() }),
    view.getByRole('combobox', { name: m.moderation_filter_kind() }),
    view.getByRole('combobox', { name: m.moderation_filter_order() }),
  ];
  const reset = view.getByRole('button', { name: m.moderation_filter_reset() });
  const summary = canvasElement.ownerDocument.getElementById(group.getAttribute('aria-describedby')!)!;
  await expect(summary).toBeVisible();
  const selectedLabels = selects.map((select) => select.querySelector('option:checked')!.textContent!);
  await expect(summary).toHaveTextContent(
    m.moderation_controls_details_summary({
      status: selectedLabels[0]!,
      kind: selectedLabels[1]!,
      order: selectedLabels[2]!,
    }),
  );
  for (const select of selects) {
    await expect(select).toHaveAccessibleName(select.closest('label')!.querySelector('span')!.textContent!);
    await expect(summary).toHaveTextContent(select.querySelector('option:checked')!.textContent!);
  }
  for (const control of [back, ...links, ...selects, reset]) {
    await expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
  }
  await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth);
  const document = canvasElement.ownerDocument;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
  back.focus();
  await expect(back).toHaveFocus();
  for (const link of links) {
    await userEvent.tab();
    await expect(link).toHaveFocus();
  }
  return { view, group, selects, reset, summary };
}

export const SelectedReports: Story = {
  args: { onSelection: fn() },
  globals: {},
  play: async ({ canvasElement, args }) => {
    const { selects, reset } = await observeControls(canvasElement);
    for (const select of selects) {
      await userEvent.tab();
      await expect(select).toHaveFocus();
    }
    await userEvent.tab();
    await expect(reset).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSelection).toHaveBeenCalledWith(DEFAULT_REPORT_SELECTION);
  },
};

export const SelectedAppeals: Story = {
  args: { tab: 'appeals', onSelection: fn() },
  globals: {},
  play: async ({ canvasElement }) => {
    await observeControls(canvasElement, 'appeals');
  },
};

export const DisabledSelection: Story = {
  globals: {},
  play: async ({ canvasElement }) => {
    const { group, selects, reset } = await observeControls(canvasElement);
    await expect(group).toBeDisabled();
    for (const control of [...selects, reset]) await expect(control).toBeDisabled();
  },
};

export const PendingSelection: Story = {
  args: { onSelection: fn(() => new Promise<void>(() => {})) },
  globals: {},
  play: async ({ canvasElement, args }) => {
    const { view, group, selects, reset } = await observeControls(canvasElement);
    await userEvent.selectOptions(selects[0]!, 'resolved');
    await expect(args.onSelection).toHaveBeenCalledTimes(1);
    await expect(args.onSelection).toHaveBeenCalledWith({ status: 'resolved', targetKind: 'post', order: 'oldest' });
    await expect(group).toBeDisabled();
    await expect(reset).toBeDisabled();
    await expect(view.getByRole('status')).toHaveTextContent(m.moderation_queue_loading());
    await expect(view.queryByText(postReport.evidence!)).toBeNull();
    for (const link of view.getByRole('navigation', { name: m.moderation_tabs_label() }).querySelectorAll('a')) {
      link.focus();
      await expect(link).toHaveFocus();
    }
  },
};

export const LongLocalizedPhone: Story = {
  args: { selection: { status: 'all', targetKind: 'all', order: 'oldest' }, onSelection: fn() },
  globals: { locale: 'fr' },
  play: async ({ canvasElement, args }) => {
    await observeControls(canvasElement, 'reports', args.selection);
  },
};
export const LongLocalizedDesktop: Story = {
  ...LongLocalizedPhone,
  globals: { locale: 'fr' },
};
export const LongLocalizedRtlPhone: Story = {
  ...LongLocalizedPhone,
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
