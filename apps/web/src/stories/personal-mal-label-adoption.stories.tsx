import type { Meta, StoryObj } from '@storybook/react-vite';
import { MalRowReview } from '../library/personal-mal-import/row';
import { MalConfirmPage } from '../library/personal-mal-import/confirm';
import { MalResultPage } from '../library/personal-mal-import/results';
import { labelReviewRow as row } from '../library/personal-mal-import/labels.fixture';

const meta = {
  title: 'Library/MAL label adoption',
  component: MalRowReview,
  args: { row, busy: false, onSave: () => {} },
  parameters: {
    layout: 'padded',
    viewport: {
      options: {
        phone: { name: '390', styles: { width: '390px', height: '844px' } },
        desktop: { name: '1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof MalRowReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Review: Story = {};
export const Confirmation: Story = {
  render: () => (
    <MalConfirmPage
      rows={[row]}
      busy={false}
      confirmPrivacy={false}
      confirmTimestamps={false}
      onBack={() => {}}
      onConfirm={() => {}}
      onConfirmSource={() => {}}
    />
  ),
};
export const PartialResults: Story = {
  render: () => (
    <MalResultPage
      result={{
        id: 'retained',
        stopped: true,
        remaining: [0],
        outcomes: [
          {
            row: 0,
            status: 'applied',
            applied: ['tags'],
            retained: [],
            reason: null,
            labels: [
              {
                value: 0,
                status: 'accepted',
                labelId: 'native-label',
                assignment: { id: 'native-assignment', revision: 1 },
                reason: null,
              },
            ],
            remainingLabels: [1, 2],
          },
        ],
      }}
      titles={new Map([[0, row.title]])}
      admissions={new Map()}
      busy={false}
      canRetry={false}
      onRetry={() => {}}
      onReview={() => {}}
      onRefresh={() => {}}
    />
  ),
};
