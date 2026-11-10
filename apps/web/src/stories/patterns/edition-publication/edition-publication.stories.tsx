import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import { localizeHref } from '../../../paraglide/runtime.js';
import { EditionPublicationExample, editionId, fixedText, imageAlt, subjectId } from './edition-publication-fixtures';

const meta = {
  title: 'Content/EditionPublication Workflow',
  id: 'patterns-content-editionpublication',
  component: EditionPublicationExample,
  parameters: { layout: 'fullscreen' },
  args: { state: 'selection' },
} satisfies Meta<typeof EditionPublicationExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Selection: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(fixedText);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.edition_publication_subject() }), subjectId);
    await userEvent.click(canvas.getByRole('button', { name: m.edition_publication_create() }));
    await canvas.findByRole('heading', { name: m.edition_publication_draft_heading() });
    await expect(canvas.queryByRole('link', { name: m.edition_publication_open() })).toBeNull();
    await userEvent.click(canvas.getByRole('checkbox'));
    const publish = canvas.getByRole('button', { name: m.edition_publication_publish() });
    for (let step = 0; step < 8 && document.activeElement !== publish; step++) await userEvent.tab();
    await expect(publish).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByRole('heading', { name: m.edition_publication_published_heading() });
    await expect(canvas.getByRole('link', { name: m.edition_publication_open() })).toHaveAttribute(
      'href',
      expect.stringContaining(`/editions/${editionId}`),
    );
  },
};
export const Draft: Story = { args: { state: 'draft' } };
export const Published: Story = {
  args: { state: 'published' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.edition_publication_published_heading() });
    const createOffer = canvas.getByRole('link', { name: m.edition_publication_create_offer() });
    await expect(createOffer).toBeVisible();
    await expect(createOffer).toHaveAttribute(
      'href',
      localizeHref(`/creator/offers/new?editionId=${encodeURIComponent(editionId)}`),
    );
    await expect(canvas.getByRole('link', { name: m.edition_publication_open() })).toHaveAttribute(
      'href',
      localizeHref(`/editions/${encodeURIComponent(editionId)}`),
    );
  },
};
export const Refused: Story = { args: { state: 'refused' } };
export const Conflict: Story = { args: { state: 'conflict' } };
export const Uncertain: Story = {
  args: { state: 'uncertain' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.edition_publication_uncertain());
    await expect(canvas.getByText(fixedText)).toBeVisible();
    await expect(canvas.getByRole('combobox')).toHaveValue(subjectId);
    await userEvent.click(canvas.getByRole('button', { name: m.edition_publication_retry() }));
    await canvas.findByRole('heading', { name: m.edition_publication_draft_heading() });
    await expect(canvas.queryByText(m.edition_publication_uncertain())).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.edition_publication_open() })).toBeNull();
  },
};

export const ResumedDraft: Story = {
  args: { state: 'resumed-draft' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.edition_publication_resume_heading() });
    await canvas.findByRole('heading', { name: m.edition_publication_draft_heading() });
    await expect(canvas.queryByText(fixedText)).toBeNull();
    await expect(canvas.queryByRole('combobox')).toBeNull();
    await expect(canvas.queryByRole('button', { name: m.edition_publication_create() })).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.edition_publication_create_offer() })).toBeNull();
    await userEvent.click(canvas.getByRole('checkbox'));
    await userEvent.click(canvas.getByRole('button', { name: m.edition_publication_publish() }));
    await canvas.findByRole('heading', { name: m.edition_publication_published_heading() });
    await expect(canvas.getByRole('link', { name: m.edition_publication_create_offer() })).toHaveAttribute(
      'href',
      localizeHref(`/creator/offers/new?editionId=${encodeURIComponent(editionId)}`),
    );
  },
};
export const ReloadedPublished: Story = { ...Published, args: { state: 'reloaded-published' } };
export const ResumedConflict: Story = {
  args: { state: 'resumed-conflict' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.edition_publication_conflict());
    await userEvent.click(canvas.getByRole('button', { name: m.edition_publication_refresh() }));
    await canvas.findAllByText(m.edition_publication_edition_version({ revision: '2' }));
    await expect(canvas.getByRole('button', { name: m.edition_publication_publish() })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: m.edition_publication_accept_review() }));
    await canvas.findByRole('heading', { name: m.edition_publication_draft_heading() });
    await expect(canvas.getByRole('checkbox')).not.toBeChecked();
  },
};
export const UncertainPublish: Story = {
  args: { state: 'uncertain-publish' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.edition_publication_uncertain());
    await expect(canvas.queryByRole('link', { name: m.edition_publication_create_offer() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.edition_publication_retry() }));
    await canvas.findByRole('heading', { name: m.edition_publication_published_heading() });
  },
};

export const ImagePreviewUnavailable: Story = {
  args: { state: 'image-preview-unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(fixedText);
    await expect(await canvas.findByRole('img', { name: imageAlt })).toHaveTextContent(
      m.content_edition_image_unavailable(),
    );
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.edition_publication_subject() }), subjectId);
    // A missing independent media presentation neither grants nor refuses native edition creation.
    await expect(canvas.getByRole('button', { name: m.edition_publication_create() })).toBeEnabled();
    await expect(canvas.queryByRole('link', { name: m.edition_publication_create_offer() })).toBeNull();
  },
};
