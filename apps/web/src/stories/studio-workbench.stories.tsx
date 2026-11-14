import type { Meta, StoryObj } from '@storybook/react-vite';
import { StudioWorkbenchReview } from './studio-workbench-review';

const meta = {
  title: 'Pages/Studio/Workbench',
  id: 'pages-studio-workbench',
  component: StudioWorkbenchReview,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Stable manual review entries using the installed workbench and real controller in the routed signed-in shell. Constructed response fixtures illustrate private drafting; publication is unavailable and no release is invented. Use all eight locale globals, both themes and phone390/desktop1280. Dirty reviews retain working text after a supplied stale save: choose another draft, then save, discard or keep editing. Comparison starts with one explicitly selected saved version. Scripted walks are under Walks/Studio/Workbench; native, visual and promoted acceptance remain verifier work.',
      },
    },
  },
} satisfies Meta<typeof StudioWorkbenchReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Book: Story = { args: { profile: 'book', scenario: 'populated' } };
export const Column: Story = { args: { profile: 'column', scenario: 'populated' } };
export const BookDirtyReview: Story = { args: { profile: 'book', scenario: 'dirty' } };
export const ColumnDirtyReview: Story = { args: { profile: 'column', scenario: 'dirty' } };
export const BookRevisionComparison: Story = { args: { profile: 'book', scenario: 'comparison' } };
export const ColumnRevisionComparison: Story = { args: { profile: 'column', scenario: 'comparison' } };
export const BookPreparationUnavailable: Story = { args: { profile: 'book', scenario: 'preparation-unavailable' } };
export const ColumnPreparationUnavailable: Story = { args: { profile: 'column', scenario: 'preparation-unavailable' } };
