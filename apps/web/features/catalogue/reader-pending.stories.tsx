import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { memoryReaderActions, storyWorkId } from './fixtures.ts';
import { RateWork, ReaderActionsProvider } from './reader-actions.tsx';

const work = storyWorkId(1);
const signInHref = '/auth/start?next=%2Fen%2Fdiscover';

const meta = {
  title: 'Catalogue/Rating write states',
  parameters: {
    docs: {
      description: {
        component:
          'A rating Main has admitted but not applied is shown as pending, read back a few times, and then either settles or says it is still being processed with a refresh. Nothing is kept in the browser.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  render: () => (
    <div className="p-6">
      <ReaderActionsProvider signedIn signInHref={signInHref}
        actions={memoryReaderActions({ [work]: { rating: 4, ratingWrite: 'pending' } })}>
        <RateWork work={work} locale="en" />
      </ReaderActionsProvider>
    </div>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Saving…')).toBeVisible();
  },
};

export const StillProcessing: Story = {
  render: () => {
    const refresh = fn(async () => {});
    return (
      <div className="p-6">
        <ReaderActionsProvider signedIn signInHref={signInHref}
          actions={{ ...memoryReaderActions({ [work]: { rating: 4, ratingWrite: 'unsettled' } }), refresh }}>
          <RateWork work={work} locale="en" />
        </ReaderActionsProvider>
      </div>
    );
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/still being processed/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh' }));
  },
};
