import type { Meta, StoryObj } from '@storybook/react-vite';
import { EditionPublicationExample } from './patterns/edition-publication/edition-publication-fixtures';
import * as pattern from './patterns/edition-publication/edition-publication.stories';

const meta = {
  title: 'Content/EditionPublication Page',
  id: 'pages-content-editionpublication',
  component: EditionPublicationExample,
  parameters: { layout: 'fullscreen' },
  args: { state: 'selection', shell: true },
} satisfies Meta<typeof EditionPublicationExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Selection: Story = { ...pattern.Selection };
export const Draft: Story = { ...pattern.Draft };
export const Published: Story = { ...pattern.Published };
export const Refused: Story = { ...pattern.Refused };
export const Conflict: Story = { ...pattern.Conflict };
export const Uncertain: Story = { ...pattern.Uncertain };
export const ResumedDraft: Story = { ...pattern.ResumedDraft };
export const ReloadedPublished: Story = { ...pattern.ReloadedPublished };
export const ResumedConflict: Story = { ...pattern.ResumedConflict };
export const UncertainPublish: Story = { ...pattern.UncertainPublish };
export const ImagePreviewUnavailable: Story = { ...pattern.ImagePreviewUnavailable };
