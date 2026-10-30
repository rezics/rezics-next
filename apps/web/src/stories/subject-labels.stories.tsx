import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { setFakeAdmitted } from '../kernel/fake';
import { setLibraryLabelStorySizes } from '../kernel/fake/library-label-assignments';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = { title: 'Pages/Subject/Personal Labels', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function SubjectLabelsStory({ count = 3 }: { count?: number }) {
  setFakeAdmitted([
    'personal_library',
    'reading_progress',
    'library_label.assignment_list',
    'library_label.list',
    'library_label.create',
    'library_label.assign',
    'library_label.unassign',
  ]);
  setLibraryLabelStorySizes({ subject: count });
  return <PageStory visitor="Signed In" path={pagePaths.subject} />;
}

async function labelsReady(context: { canvasElement: HTMLElement }, count: number) {
  await pageReady(context);
  const canvas = within(context.canvasElement);
  await canvas.findByRole('button', { name: m.library_subject_label_add() });
  await expect(context.canvasElement.querySelectorAll('[data-subject-label-chip]')).toHaveLength(count);
}

export const NoLabels: Story = {
  name: 'No labels',
  render: () => <SubjectLabelsStory count={0} />,
  play: (context) => labelsReady(context, 0),
};

export const ThreeLabels: Story = {
  name: 'Three labels',
  render: () => <SubjectLabelsStory count={3} />,
  play: (context) => labelsReady(context, 3),
};

export const ThirtyTwoLabels: Story = {
  name: 'Thirty-two labels',
  render: () => <SubjectLabelsStory count={32} />,
  play: (context) => labelsReady(context, 32),
};

export const PickerOpen: Story = {
  name: 'Picker open',
  render: () => <SubjectLabelsStory count={3} />,
  play: async (context) => {
    await labelsReady(context, 3);
    const canvas = within(context.canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.library_subject_label_add() }));
    const input = await canvas.findByRole('textbox', { name: m.library_subject_label_name() });
    await userEvent.type(input, 'New shelf label');
    await canvas.findByRole('button', { name: m.library_subject_label_create({ name: 'New shelf label' }) });
  },
};

export const UndoVisible: Story = {
  name: 'Undo visible',
  render: () => <SubjectLabelsStory count={3} />,
  play: async (context) => {
    await labelsReady(context, 3);
    const canvas = within(context.canvasElement);
    await userEvent.click(
      canvas.getByRole('button', { name: m.library_subject_label_remove({ name: 'Reading list' }) }),
    );
    await canvas.findByRole('button', { name: m.library_subject_label_undo() });
  },
};
