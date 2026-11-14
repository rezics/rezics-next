import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
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
    const title = await canvas.findByRole('textbox', { name: m.studio_workspace_title(), exact: true });
    await openNavigation(canvasElement);
    const outline = canvas.getByRole('region', { name: m.studio_book_outline_label() });
    await userEvent.click(within(outline).getByRole('button', { name: 'A map drawn from memory', exact: true }));
    await expect(canvas.getByRole('region', { name: m.studio_workspace_switch_region() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_keep_editing(), exact: true }));
    await expect(title).toHaveValue('The lighthouse before dawn · working draft');
    await openNavigation(canvasElement);
    await userEvent.click(within(outline).getByRole('button', { name: 'A map drawn from memory', exact: true }));
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_save_switch(), exact: true }));
    await expect(await canvas.findByRole('heading', { name: 'A map drawn from memory', exact: true })).toBeVisible();
  },
};

export const ComparisonSurvivesPreview: Story = {
  args: { profile: 'column', scenario: 'comparison' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.studio_revision_selected(), exact: true });
    await userEvent.click(canvas.getByRole('button', { name: m.studio_revision_use(), exact: true }));
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_preview(), exact: true }));
    await expect(canvas.getByRole('region', { name: m.studio_workspace_preview_region() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_versions(), exact: true }));
    await expect(canvas.getByRole('group', { name: m.studio_revision_copy_review() })).toBeVisible();
    await expect(canvas.getByRole('heading', { name: m.studio_revision_selected(), exact: true })).toBeVisible();
  },
};

export const UnavailablePreparationKeepsWritingAvailable: Story = {
  args: { profile: 'book', scenario: 'preparation-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = await canvas.findByRole('textbox', { name: m.studio_workspace_title(), exact: true });
    await expect(canvasElement.querySelector('.studio-publication-region > [role="status"]')).toHaveTextContent(
      m.studio_release_unavailable(),
    );
    await expect(title).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_preview(), exact: true }));
    await expect(canvas.getByRole('region', { name: m.studio_workspace_preview_region() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.studio_workspace_write(), exact: true }));
    await expect(title).toBeEnabled();
  },
};
