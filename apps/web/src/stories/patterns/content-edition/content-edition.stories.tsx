import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import {
  ContentEditionExample,
  editionFixture,
  type EditionExampleState,
  editionImage,
  editionImageAlt,
  editionText,
  editionViewports,
  revisionId,
  subjectId,
} from './content-edition-fixtures';

const meta = {
  title: 'Commerce/ContentEditionReader Workflow',
  id: 'patterns-commerce-contenteditionreader',
  component: ContentEditionExample,
  parameters: { layout: 'fullscreen', viewport: { options: editionViewports } },
  args: { state: 'published' },
} satisfies Meta<typeof ContentEditionExample>;
export default meta;
type Story = StoryObj<typeof meta>;

async function inspectDetails(canvasElement: HTMLElement, state: EditionExampleState = 'published') {
  const canvas = within(canvasElement);
  const details = canvasElement.querySelector('details')!;
  const { metadata } = await editionFixture(state);
  await expect(details).not.toHaveAttribute('open');
  await expect(canvas.getByText(metadata.revisionId)).not.toBeVisible();
  await userEvent.click(canvas.getByText(m.content_edition_details()));
  await expect(details).toHaveAttribute('open');
  for (const value of [metadata.revisionId, metadata.editionId, metadata.editionRevision, metadata.sha256])
    await expect(within(details).getByText(value, { exact: true })).toBeVisible();
  await userEvent.click(canvas.getByText(m.content_edition_details()));
  await expect(details).not.toHaveAttribute('open');
}

export const Published: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(editionText);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Reading the quiet ending' })).toBeVisible();
    await expect(canvas.getByText('CC-BY-SA-4.0')).toBeVisible();
    await inspectDetails(canvasElement);
    const link = canvas.getByRole('link', { name: m.content_edition_subject() });
    await expect(link).toHaveAttribute('href', expect.stringContaining(`/subjects/${subjectId}/`));
    for (let step = 0; step < 45 && document.activeElement !== link; step += 1) await userEvent.tab();
    await expect(link).toHaveFocus();
  },
};
export const Publishedimages: Story = {
  args: { state: 'published-images' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(editionText);
    const image = await canvas.findByRole('img', { name: editionImageAlt });
    await expect(image).toHaveAttribute('alt', editionImageAlt);
    await expect(image).toHaveAttribute('src', expect.stringMatching(`/media/${editionImage.id}/webp-(320|640)$`));
    await inspectDetails(canvasElement, 'published-images');
  },
};
export const Missingimage: Story = {
  args: { state: 'missing-image' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(editionText);
    await expect(await canvas.findByRole('img', { name: editionImageAlt })).toBeVisible();
    await expect(canvasElement.querySelector('img')).toBeNull();
    await inspectDetails(canvasElement, 'missing-image');
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
    await expect(within(canvasElement).queryByRole('button', { name: m.content_edition_retry() })).toBeNull();
    await expect(within(canvasElement).queryByRole('link', { name: m.content_edition_purchases() })).toBeNull();
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
    await expect(canvas.getByRole('link', { name: m.content_edition_purchases() })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/orders$/),
    );
  },
};
export const Retryrecovers: Story = {
  name: 'Retry recovers unavailable edition',
  args: { state: 'unavailable', recoverOnRetry: true },
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
    await inspectDetails(canvasElement);
  },
};
export const Refused: Story = {
  args: { state: 'refused' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.content_edition_refused());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.content_edition_subject() })).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.content_edition_retry() })).toBeNull();
    await expect(canvas.getByRole('link', { name: m.content_edition_purchases() })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/orders$/),
    );
  },
};
export const Withdrawn: Story = {
  args: { state: 'withdrawn' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.content_edition_withdrawn());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.content_edition_retry() })).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.content_edition_subject() })).toBeNull();
    await expect(canvas.getByRole('link', { name: m.content_edition_purchases() })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/orders$/),
    );
  },
};
export const Versionmismatch: Story = {
  args: { state: 'version-mismatch' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.content_edition_version_mismatch());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
    await expect(canvas.queryByText(revisionId)).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.content_edition_subject() })).toBeNull();
    await expect(canvas.getByRole('link', { name: m.content_edition_purchases() })).toHaveAttribute(
      'href',
      expect.stringMatching(/\/orders$/),
    );
    await expect(canvas.getByRole('button', { name: m.content_edition_retry() })).toBeVisible();
  },
};
