import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { CopiesPage } from '../library/copies-page';
import type { NativeCopyList } from '../library/copies-server';
import { m } from '../paraglide/messages.js';
import { PatternStory, pagePaths } from './page';

const meta = {
  title: 'Patterns/Library/Copies filters',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const nativeOptions: NativeCopyList['filterOptions'] = {
  kinds: {
    state: 'available',
    choices: [
      { id: 'print', label: 'Papier ancien', labelLanguage: 'fr', meaning: 'available' },
      { id: 'retired', label: 'retired', meaning: 'unsupported' },
      { id: 'unknown', label: 'unknown', meaning: 'unavailable' },
    ],
  },
  statuses: {
    state: 'available',
    choices: [{ id: 'shelf', label: 'On shelf', labelLanguage: 'en', meaning: 'available' }],
  },
};
function FilteredInventory({
  unavailable = false,
  missing = false,
  empty = false,
}: {
  unavailable?: boolean;
  missing?: boolean;
  empty?: boolean;
}) {
  return (
    <PatternStory visitor="Signed In" path={`${pagePaths['library-copies']}?kind=print&status=shelf`}>
      <div className="min-w-0 p-4">
        <CopiesPage
          page={{
            signedIn: true,
            subjectId: null,
            kind: empty ? null : missing ? 'lost-kind' : 'print',
            status: empty ? null : 'shelf',
            copies: [],
            next: null,
            addKey: 'story-only',
            filterOptions: unavailable
              ? { kinds: { state: 'unavailable', choices: [] }, statuses: { state: 'unavailable', choices: [] } }
              : empty
                ? { kinds: { state: 'available', choices: [] }, statuses: { state: 'available', choices: [] } }
                : nativeOptions,
          }}
        />
      </div>
    </PatternStory>
  );
}
export const HistoricalChoices: Story = {
  render: () => <FilteredInventory />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('combobox', { name: m.library_copy_kind() })).toHaveValue('print');
    expect(
      canvas.getByRole('option', { name: `retired — ${m.library_copy_filter_unsupported()}` }),
    ).toBeInTheDocument();
    expect(
      canvas.getByRole('option', { name: `unknown — ${m.library_copy_filter_unavailable()}` }),
    ).toBeInTheDocument();
    expect(canvas.getByText(m.library_copy_matching_empty())).toBeVisible();
  },
};
export const SelectedLabelMissing: Story = {
  render: () => <FilteredInventory missing />,
  async play({ canvasElement }) {
    expect(within(canvasElement).getByRole('combobox', { name: m.library_copy_kind() })).toHaveValue('lost-kind');
  },
};
export const FilterOptionsUnavailable: Story = {
  render: () => <FilteredInventory unavailable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    expect(canvas.getAllByText(m.library_copy_filter_options_unavailable())).toHaveLength(2);
    expect(canvas.getByRole('combobox', { name: m.library_copy_status() })).toHaveValue('shelf');
    expect(canvas.getByText(m.library_copy_matching_empty())).toBeVisible();
  },
};
export const EmptyInventory: Story = {
  render: () => <FilteredInventory empty />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    expect(canvas.getAllByText(m.library_copy_filter_none())).toHaveLength(2);
    expect(canvas.getByText(m.library_copy_empty())).toBeVisible();
  },
};
