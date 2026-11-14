import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { StudioWorkbenchReview } from './studio-workbench-review';

const meta = {
  title: 'Walks/Studio/Workbench',
  id: 'walks-studio-workbench',
  component: StudioWorkbenchReview,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StudioWorkbenchReview>;
export default meta;
type Story = StoryObj<typeof meta>;

async function openNavigation(canvasElement: HTMLElement) {
  const navigation = canvasElement.querySelector<HTMLDetailsElement>('.studio-mobile-navigation')!;
  if (!navigation.open) await userEvent.click(navigation.querySelector('summary')!);
}

export const DirtySwitchKeepsWorkingText: Story = {
  args: { profile: 'book', scenario: 'dirty' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('textbox', { name: m.studio_workspace_title() });
    await openNavigation(canvasElement);
    const outline = canvas.getByRole('region', { name: m.studio_book_outline_label() });
    await userEvent.click(within(outline).getByRole('button', { name: 'A map drawn from memory' }));
    await expect(canvas.getByRole('region', { name: m.studio_workspace_switch_region() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_keep_editing() }));
    await expect(title).toHaveValue('The lighthouse before dawn · working draft');
    await openNavigation(canvasElement);
    await userEvent.click(within(outline).getByRole('button', { name: 'A map drawn from memory' }));
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_save_switch() }));
    await expect(await canvas.findByRole('heading', { name: 'A map drawn from memory' })).toBeVisible();
  },
};

export const ComparisonSurvivesPreview: Story = {
  args: { profile: 'column', scenario: 'comparison' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.studio_revision_selected() });
    await userEvent.click(canvas.getByRole('button', { name: m.studio_revision_use() }));
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_preview() }));
    await expect(canvas.getByRole('region', { name: m.studio_workspace_preview_region() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_versions() }));
    await expect(canvas.getByRole('group', { name: m.studio_revision_copy_review() })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: m.studio_revision_selected() })).toBeVisible();
  },
};

export const UnavailablePreparationKeepsWritingAvailable: Story = {
  args: { profile: 'book', scenario: 'preparation-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('textbox', { name: m.studio_workspace_title() });
    await expect(canvasElement.querySelector('.studio-publication-region > [role="status"]')).toHaveTextContent(
      m.studio_release_unavailable(),
    );
    await expect(title).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_preview() }));
    await expect(canvas.getByRole('region', { name: m.studio_workspace_preview_region() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_write() }));
    await expect(title).toBeEnabled();
  },
};

export const WorkingPreviewReturnsToDraft: Story = {
  args: { profile: 'book', scenario: 'working-preview' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('textbox', { name: m.studio_workspace_title(), exact: true });
    const editor = canvasElement.querySelector<HTMLElement>('.tiptap')!;
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: m.studio_workspace_preview(), exact: true })).toBeEnabled(),
    );
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_preview(), exact: true }));
    const preview = canvas.getByRole('region', { name: m.studio_workspace_preview_region() });
    const reading = within(preview);
    await expect(reading.getByRole('heading', { name: 'Harbour observations' })).toBeVisible();
    await userEvent.click(reading.getByRole('button', { name: m.thread_reveal_spoiler() }));
    await userEvent.click(reading.getByRole('button', { name: m.wide_document_code_inspect() }));
    const page = within(canvasElement.ownerDocument.body);
    let dialog = page.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: m.wide_document_code_wrap() }));
    await expect(dialog.querySelector('code')).toHaveTextContent('const readings');
    await userEvent.click(within(dialog).getByRole('button', { name: m.wide_document_inspector_close(), exact: true }));
    await waitFor(() => expect(page.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(reading.getByRole('button', { name: m.wide_document_table_inspect() }));
    dialog = page.getByRole('dialog');
    await expect(within(dialog).getByRole('cell', { name: 'East harbour' })).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: m.wide_document_inspector_close(), exact: true }));
    await waitFor(() => expect(page.queryByRole('dialog')).not.toBeInTheDocument());
    await userEvent.click(reading.getByRole('button', { name: m.post_references_title(), exact: true }));
    dialog = page.getByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', {
        name: m.post_references_entry({ number: 1, label: 'field source' }),
        exact: true,
      }),
    );
    await expect(within(dialog).getByRole('textbox', { name: m.post_references_destination() })).toHaveValue(
      'https://example.org/harbour?edition=1#notes',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: m.post_references_return(), exact: true }));
    await waitFor(() => expect(reading.getByRole('link', { name: 'field source', exact: true })).toHaveFocus());
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_write(), exact: true }));
    await expect(title).toBeVisible();
    await expect(canvasElement.querySelector('.tiptap')).toBe(editor);
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_preview(), exact: true }));
    await expect(canvas.getByRole('button', { name: m.thread_reveal_spoiler() })).toBeVisible();
  },
};
