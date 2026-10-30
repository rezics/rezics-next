import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import {
  ContentEditionExample,
  editionText,
  editionViewports,
  revisionId,
  subjectId,
} from './content-edition-fixtures';

const meta = {
  title: 'Patterns/Commerce/ContentEditionReader',
  component: ContentEditionExample,
  parameters: { layout: 'fullscreen', viewport: { options: editionViewports } },
  args: { state: 'published' },
} satisfies Meta<typeof ContentEditionExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Published: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(editionText);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Reading the quiet ending' })).toBeVisible();
    await expect(canvas.getByText('CC-BY-SA-4.0')).toBeVisible();
    await expect(canvas.getByText(revisionId)).toBeVisible();
    const link = canvas.getByRole('link', { name: m.content_edition_subject() });
    await expect(link).toHaveAttribute('href', expect.stringContaining(`/subjects/${subjectId}/`));
    for (let step = 0; step < 45 && document.activeElement !== link; step += 1) await userEvent.tab();
    await expect(link).toHaveFocus();
  },
};
export const Longtext: Story = {
  args: { state: 'longtext' },
  play: async ({ canvasElement }) => {
    const last = await within(canvasElement).findByText(`32. ${editionText}`);
    last.scrollIntoView({ block: 'center' });
    await expect(last).toBeVisible();
  },
};
export const Loading: Story = {
  args: { state: 'loading' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(m.content_edition_loading());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
export const Unavailable: Story = {
  args: { state: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.content_edition_unavailable());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    const retry = canvas.getByRole('button', { name: m.content_edition_retry() });
    for (let step = 0; step < 45 && document.activeElement !== retry; step += 1) await userEvent.tab();
    await expect(retry).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(editionText);
    await expect(canvas.queryByText(m.content_edition_unavailable())).toBeNull();
  },
};
export const Refused: Story = {
  args: { state: 'refused' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.content_edition_refused());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.content_edition_subject() })).toBeNull();
  },
};
export const Withdrawn: Story = {
  args: { state: 'withdrawn' },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.content_edition_withdrawn());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
export const Versionmismatch: Story = {
  args: { state: 'version-mismatch' },
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.content_edition_version_mismatch());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
