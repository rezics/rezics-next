import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ContextCurationStory } from '../features/catalogue/context-curation-story';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Catalogue/Context review',
  component: ContextCurationStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ContextCurationStory>;
export default meta;
type Story = StoryObj<typeof meta>;
async function open(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.candidate_entry() }));
  return canvas;
}
async function replace(canvasElement: HTMLElement) {
  const canvas = await open(canvasElement);
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: m.context_mode() }), 'replace');
  for (const choice of canvas.getAllByRole('checkbox'))
    if (choice.getAttribute('aria-checked') === 'true') await userEvent.click(choice);
  await userEvent.click(canvas.getAllByRole('checkbox').at(-1)!);
  await userEvent.click(canvas.getByRole('button', { name: m.context_adopt() }));
  return canvas;
}
async function confirm(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const heading = canvas.getByRole('heading', { name: m.candidate_confirm_title({ action: m.context_adopt() }) });
  await userEvent.click(within(heading.parentElement!).getByRole('button', { name: m.context_adopt() }));
  return canvas;
}
export const Inherited: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.context_inherited());
    expect(canvas.getByRole('link', { name: m.candidate_view_public() })).toBeTruthy();
  },
};
export const Replaced: Story = {
  args: { scenario: 'replaced' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.context_replaced());
  },
};
export const Suppressed: Story = {
  args: { scenario: 'suppressed' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.context_suppressed());
  },
};
export const Unresolved: Story = {
  args: { scenario: 'unresolved' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.context_unresolved());
  },
};
export const Saved: Story = {
  play: async ({ canvasElement }) => {
    await replace(canvasElement);
    const canvas = await confirm(canvasElement);
    await canvas.findByText(m.context_saved());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByText(m.context_replaced());
  },
};
export const Conflict: Story = {
  args: { scenario: 'conflict' },
  play: async ({ canvasElement }) => {
    await replace(canvasElement);
    const canvas = await confirm(canvasElement);
    await canvas.findByText(m.candidate_draft_stale());
    expect(canvas.getByRole('button', { name: m.context_adopt() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByRole('combobox', { name: m.context_mode() });
    expect(canvas.getAllByRole('checkbox').at(-1)!).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: m.context_adopt() }));
    await confirm(canvasElement);
    await canvas.findByText(m.context_saved());
  },
};
export const Denied: Story = {
  args: { scenario: 'adopt-denied' },
  play: async ({ canvasElement }) => {
    await replace(canvasElement);
    const canvas = await confirm(canvasElement);
    await canvas.findByText(m.candidate_denied());
    expect(canvas.queryByRole('combobox', { name: m.context_mode() })).toBeNull();
  },
};
export const Invalid: Story = {
  args: { scenario: 'invalid' },
  play: async ({ canvasElement }) => {
    await replace(canvasElement);
    const canvas = await confirm(canvasElement);
    await canvas.findByText(m.candidate_invalid());
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.candidate_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
    await canvas.findByText(m.candidate_unavailable());
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.candidate_empty());
  },
};
export const Loading: Story = {
  args: { scenario: 'loading' },
  play: async ({ canvasElement }) => {
    const canvas = await open(canvasElement);
    await canvas.findByText(m.candidate_loading());
  },
};
