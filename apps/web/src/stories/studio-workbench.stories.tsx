import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { workbenchCopy } from '../studio/workbench-copy';
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
const newDraft: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const copy = workbenchCopy[getLocale()];
  const selected = await canvas.findByRole('textbox', { name: m.studio_workspace_title(), exact: true });
  await userEvent.click(canvas.getByRole('button', { name: copy.newDraft, exact: true }));
  const form = canvas.getByRole('form', { name: copy.newDraft });
  const title = within(form).getByRole('textbox', { name: m.studio_workspace_new_title() });
  await userEvent.type(title, 'An unsent opening');
  await expect(selected).not.toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: copy.returnToDocument }));
  await expect(selected).toBeVisible();
  await expect(form).not.toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: copy.newDraft, exact: true }));
  await expect(title).toHaveValue('An unsent opening');
  await expect(title).toHaveFocus();
};
export const BookNewDraft: Story = { args: { profile: 'book', scenario: 'populated' }, play: newDraft };
export const ColumnNewDraft: Story = { args: { profile: 'column', scenario: 'populated' }, play: newDraft };
export const BookDirtyReview: Story = { args: { profile: 'book', scenario: 'dirty' } };
export const ColumnDirtyReview: Story = { args: { profile: 'column', scenario: 'dirty' } };
export const BookRevisionComparison: Story = { args: { profile: 'book', scenario: 'comparison' } };
export const ColumnRevisionComparison: Story = { args: { profile: 'column', scenario: 'comparison' } };
export const BookPreparationUnavailable: Story = { args: { profile: 'book', scenario: 'preparation-unavailable' } };
export const ColumnPreparationUnavailable: Story = { args: { profile: 'column', scenario: 'preparation-unavailable' } };

const workingPreview: Story['play'] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const preview = await canvas.findByRole('button', { name: m.studio_workspace_preview(), exact: true });
  await waitFor(() => expect(preview).toBeEnabled());
  await userEvent.click(preview);
  await canvas.findByRole('heading', { name: 'Harbour observations' });
};
const previewDescription =
  'Illustrative native-format working snapshot in the ordinary workbench: headings, lists, quote, concealed note, footnote, long code, wide table and an unavailable attachment. Inspect code/table, use References and return to Write. Supplied mention presentation is illustrative; no media admission or publication is invented. Review phone/desktop, both themes and eight locale globals.';

export const BookWorkingPreview: Story = {
  args: { profile: 'book', scenario: 'working-preview' },
  parameters: { docs: { description: { story: previewDescription } } },
  play: workingPreview,
};
export const ColumnWorkingPreview: Story = {
  args: { profile: 'column', scenario: 'working-preview' },
  parameters: { docs: { description: { story: previewDescription } } },
  play: workingPreview,
};
export const BookWorkingPreviewUnsaved: Story = {
  args: { profile: 'book', scenario: 'working-preview-dirty' },
  parameters: {
    docs: {
      description: {
        story: `${previewDescription} A supplied stale save retains rich unsaved edits for inspection. Current saved provenance remains separate; the working body is not a saved revision.`,
      },
    },
  },
  play: workingPreview,
};
export const ColumnPreviewMissingOperands: Story = {
  args: { profile: 'column', scenario: 'working-preview-missing' },
  parameters: {
    docs: {
      description: {
        story:
          'Illustrative structured draft without supplied links, mention presentation or attachment admission. The reader offers no References control and keeps the image unavailable; it makes no lookup from an ID. Wide inspection and return to the same editor remain available.',
      },
    },
  },
  play: workingPreview,
};
