import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import { localizeHref } from '../../../paraglide/runtime.js';
import { EditionPublicationExample, editionId, fixedText, subjectId } from './edition-publication-fixtures';

const meta = {
  title: 'Patterns/Content/EditionPublication',
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
