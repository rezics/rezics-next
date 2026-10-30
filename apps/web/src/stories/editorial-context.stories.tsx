import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { EditorialContextStory } from '../features/catalogue/editorial-context-story';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Catalogue/Editorial Context',
  component: EditorialContextStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
    viewport: { options: {
      phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
      desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
    } },
    docs: { description: { component: 'Named Context lifecycle with generated requests and the existing review workspace. Samples establish no runtime availability, native authority or visual acceptance.' } },
  },
} satisfies Meta<typeof EditorialContextStory>;
export default meta;
type Story = StoryObj<typeof meta>;
async function create(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByRole('textbox', { name: m.catalogue_create_label() }), 'Readers’ choices');
  await userEvent.click(canvas.getByRole('button', { name: m.editorial_create() }));
  return canvas;
}
async function remove(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.editorial_delete() }));
  await canvas.findByText(m.editorial_confirm_delete());
  await userEvent.click(canvas.getByRole('button', { name: m.contribution_confirm() }));
  return canvas;
}
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.candidate_entry() }));
    await canvas.findByText(m.context_inherited());
  },
};
export const Empty: Story = { args: { scenario: 'create' } };
export const Created: Story = { args: { scenario: 'create' }, play: async ({ canvasElement }) => {
  const canvas = await create(canvasElement);
  await canvas.findByText(m.editorial_created());
  expect(await canvas.findByRole('link', { name: m.editorial_review() })).toHaveAttribute('href', expect.stringContaining('/context-review?context='));
} };
export const Deleted: Story = { play: async ({ canvasElement }) => {
  const canvas = await remove(canvasElement);
  await canvas.findByText(m.editorial_deleted());
  expect(canvas.queryByRole('button', { name: m.candidate_entry() })).toBeNull();
  expect(canvas.queryByRole('link', { name: m.editorial_review() })).toBeNull();
  await canvas.findByRole('button', { name: m.editorial_restore() });
} };
export const Restored: Story = { play: async ({ canvasElement }) => {
  const canvas = await remove(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.editorial_restore() }));
  await canvas.findByText(m.editorial_confirm_restore());
  await userEvent.click(canvas.getByRole('button', { name: m.contribution_confirm() }));
  await canvas.findByText(m.editorial_restored());
  await canvas.findByRole('link', { name: m.editorial_review() });
} };
export const Global: Story = { args: { scenario: 'global' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByText(m.editorial_global());
  expect(canvas.queryByRole('button', { name: m.editorial_delete() })).toBeNull();
} };
export const Denied: Story = { args: { scenario: 'denied' }, play: async ({ canvasElement }) => {
  const canvas = await remove(canvasElement);
  expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_denied());
  expect(canvas.queryByRole('button', { name: m.editorial_restore() })).toBeNull();
} };
export const Invalid: Story = { args: { scenario: 'invalid' }, play: async ({ canvasElement }) => {
  const canvas = await create(canvasElement);
  expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_invalid());
  expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('Readers’ choices');
} };
export const Conflict: Story = { args: { scenario: 'conflict' }, play: async ({ canvasElement }) => {
  const canvas = await create(canvasElement);
  expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_conflict());
} };
export const Expired: Story = { args: { scenario: 'expired' }, play: async ({ canvasElement }) => {
  const canvas = await remove(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.editorial_restore() }));
  await userEvent.click(canvas.getByRole('button', { name: m.contribution_confirm() }));
  expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_conflict());
  expect(canvas.queryByRole('link', { name: m.editorial_review() })).toBeNull();
} };
export const Concealed: Story = { args: { scenario: 'missing' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByText(m.editorial_missing());
  expect(canvas.queryByRole('button', { name: m.editorial_restore() })).toBeNull();
} };
export const Unavailable: Story = { args: { scenario: 'unavailable' }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByText(m.editorial_unavailable());
  await userEvent.click(canvas.getByRole('button', { name: m.candidate_reload() }));
  await canvas.findByRole('button', { name: m.editorial_delete() });
} };
export const RetrySameCreation: Story = { args: { scenario: 'uncertain' }, play: async ({ canvasElement }) => {
  const canvas = await create(canvasElement);
  expect(await canvas.findByRole('alert')).toHaveTextContent(m.editorial_unavailable());
  expect(canvas.getByRole('textbox', { name: m.catalogue_create_label() })).toBeDisabled();
  expect(canvas.queryByRole('button', { name: m.editorial_revise() })).toBeNull();
  await userEvent.click(canvas.getByRole('button', { name: m.editorial_retry() }));
  await canvas.findByText(m.editorial_created());
} };
export const Loading: Story = { args: { scenario: 'loading' } };
