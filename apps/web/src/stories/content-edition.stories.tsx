import type { Meta, StoryObj } from '@storybook/react-vite';
import { ContentEditionExample, editionViewports } from './patterns/content-edition/content-edition-fixtures';
import * as pattern from './patterns/content-edition/content-edition.stories';

const meta = {
  title: 'Pages/Commerce/ContentEditionReader',
  component: ContentEditionExample,
  parameters: { layout: 'fullscreen', viewport: { options: editionViewports } },
  args: { state: 'published', shell: true },
} satisfies Meta<typeof ContentEditionExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Published: Story = { ...pattern.Published };
export const Publishedimages: Story = { ...pattern.Publishedimages };
export const Missingimage: Story = { ...pattern.Missingimage };
export const Longtext: Story = { ...pattern.Longtext };
export const Loading: Story = { ...pattern.Loading };
export const Unavailable: Story = { ...pattern.Unavailable };
export const Retryrecovers: Story = { ...pattern.Retryrecovers };
export const Refused: Story = { ...pattern.Refused };
export const Withdrawn: Story = { ...pattern.Withdrawn };
export const Versionmismatch: Story = {
  ...pattern.Versionmismatch,
  name: 'Version mismatch restarts current purchases when no same-tab origin is admitted',
};
