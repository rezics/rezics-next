import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../../../paraglide/messages.js';
import { localizeHref } from '../../../paraglide/runtime.js';
import { CreatorEditionsExample, creatorEditionFixture, publishedEditionFixture } from './creator-editions-fixtures';

const meta = {
  title: 'Content/CreatorEditions Workflow',
  id: 'patterns-content-creatoreditions',
  component: CreatorEditionsExample,
  parameters: { layout: 'fullscreen' },
  args: { state: 'editions' },
} satisfies Meta<typeof CreatorEditionsExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Editions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.creator_editions_heading() });
    await expect(canvas.getByRole('link', { name: m.creator_editions_resume() })).toHaveAttribute(
      'href',
      localizeHref(`/editions/new?editionId=${creatorEditionFixture.editionId}`),
    );
    await expect(canvas.getAllByRole('link', { name: m.creator_editions_offer() })).toHaveLength(1);
    await expect(canvas.getByRole('link', { name: m.creator_editions_offer() })).toHaveAttribute(
      'href',
      localizeHref(`/creator/offers/new?editionId=${publishedEditionFixture.editionId}`),
    );
    await expect(canvas.getByRole('link', { name: m.creator_editions_read() })).toHaveAttribute(
      'href',
      localizeHref(`/editions/${publishedEditionFixture.editionId}`),
    );
  },
};
export const Sparse: Story = {
  args: { state: 'sparse' },
  play: async ({ canvasElement }) => {
    const region = await within(canvasElement).findByRole('region', { name: m.creator_editions_heading() });
    const canvas = within(region);
    await expect(await canvas.findByRole('status')).toHaveTextContent(m.creator_editions_sparse());
    await expect(canvas.getByRole('link', { name: m.creator_editions_next() })).toHaveAttribute(
      'href',
      localizeHref('/editions?cursor=constructed-next-page'),
    );
    await expect(canvas.queryByRole('list')).toBeNull();
  },
};
export const Denied: Story = { args: { state: 'denied' } };
export const Unavailable: Story = { args: { state: 'unavailable' } };
export const Empty: Story = { args: { state: 'empty' } };
export const Loading: Story = { args: { state: 'loading' } };
export const SignIn: Story = { args: { state: 'sign-in' } };
