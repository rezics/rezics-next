import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { ReportsList } from './reports-list.tsx';
import type { ReportList } from './report.ts';

const row = (n: number, category: ReportList['reports'][number]['category'] = 'harassment') => ({
  reportId: `0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a${String(n).padStart(2, '0')}`,
  caseId: `d7da7f65-f0fe-4246-bf72-93d4944738${String(n).padStart(2, '0')}`,
  receivedAt: `2026-10-0${n}T09:00:00.000Z`, category });
const page = (reports: ReportList['reports'], nextCursor: string | null = null): ReportList =>
  ({ profile: 'public-report-v1', reports, nextCursor });

let requested: string[] = [];
const meta = {
  title: 'Safety/Reports list',
  component: ReportsList,
  args: { locale: 'en', initial: page([row(1), row(2, 'ncii')]) },
  beforeEach() { requested = []; },
  render: args => <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6"><ReportsList {...args} /></div>,
} satisfies Meta<typeof ReportsList>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The reports the signed-in reporter sent; the private link is not kept, so the list points back to it. */
export const Reports: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Reports you sent')).toBeVisible();
    await expect(canvas.getByText(/private link was shown once/)).toBeVisible();
    await expect(canvas.getByText('Harassment or bullying')).toBeVisible();
    await expect(canvas.getByText('Intimate images shared without consent')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Show more reports' })).toBeNull();
  },
};

/** A long list pages by Main's cursor. */
export const ShowMore: Story = {
  args: { initial: page([row(1), row(2)], 'cursor-1'),
    send: (async (input: URL | RequestInfo) => {
      requested.push(String(input));
      return Response.json(page([row(3, 'copyright')]));
    }) as typeof fetch },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Show more reports' }));
    await waitFor(() => expect(canvas.getByText('Copyright')).toBeVisible());
    await expect(requested).toEqual(['/api/main/v1/public-reports/mine?cursor=cursor-1']);
    await expect(canvas.getAllByText('Harassment or bullying')).toHaveLength(2);
    await expect(canvas.queryByRole('button', { name: 'Show more reports' })).toBeNull();
  },
};

export const Empty: Story = {
  args: { initial: page([]) },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('You have not sent a report from this account.')).toBeVisible();
  },
};

/** A failed read says so and offers a retry that loads the list. */
export const Failed: Story = {
  args: { initial: undefined,
    send: (async (_input: URL | RequestInfo) => {
      requested.push('read');
      return requested.length === 1 ? new Response(null, { status: 503 }) : Response.json(page([row(1)]));
    }) as typeof fetch },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Your reports could not load.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(canvas.getByText('Harassment or bullying')).toBeVisible());
  },
};

export const Japanese: Story = {
  args: { locale: 'ja' },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('送信した報告')).toBeVisible();
  },
};
