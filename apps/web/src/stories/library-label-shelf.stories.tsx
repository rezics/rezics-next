import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { setFakeAdmitted } from '../kernel/fake';
import { setLibraryLabelStorySizes } from '../kernel/fake/library-label-assignments';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Library/Label Shelf', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const firstLabelId = '0192f3a0-6c1e-7b2a-9d4e-000000000801';
const emptyLabelId = '0192f3a0-6c1e-7b2a-9d4e-000000000832';

function LabelShelfStory({ count, labelId = firstLabelId }: { count: number; labelId?: string }) {
  setFakeAdmitted(['personal_library', 'reading_progress', 'library_label.assignment_list']);
  setLibraryLabelStorySizes({ subject: 3, shelf: count });
  return <PageStory visitor="Signed In" path={`/library?label=${labelId}`} />;
}

async function shelfReady(context: { canvasElement: HTMLElement }, count: number, heading: string) {
  await pageReady(context);
  const main = within(within(context.canvasElement).getByRole('main'));
  await main.findByRole('heading', { level: 1, name: heading });
  if (count === 0) await main.findByText(m.library_label_shelf_empty());
  else
    await expect(
      context.canvasElement.querySelectorAll('[data-slot="cover-card"], [data-slot="tombstone"]'),
    ).toHaveLength(count);
}

export const ThreeWorks: Story = {
  name: 'Three works',
  render: () => <LabelShelfStory count={3} />,
  play: (context) => shelfReady(context, 3, 'Reading list'),
};

export const FortyWorks: Story = {
  name: 'Forty works',
  render: () => <LabelShelfStory count={40} />,
  play: (context) => shelfReady(context, 40, 'Reading list'),
};

export const Empty: Story = {
  name: 'Empty label',
  render: () => <LabelShelfStory count={0} labelId={emptyLabelId} />,
  play: (context) => shelfReady(context, 0, 'Empty label'),
};
