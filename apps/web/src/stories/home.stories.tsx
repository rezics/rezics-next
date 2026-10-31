import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Discovery/Home',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Default Home route and consumer. Illustrative feed envelopes composed from recorded native owner summaries; these stories are not native feed acceptance evidence. Locale, theme and phone/desktop viewport use the catalogue globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {
  name: 'Member, mixed ready',
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('link', { name: 'Letters from B-612' })).toBeVisible();
    await expect(context.canvasElement.querySelector('[data-feed-source="continue"]')).not.toBeNull();
  },
};
export const SignedOut: Story = {
  render: () => <PageStory visitor="Signed Out" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    await expect(context.canvasElement.querySelector('[data-feed-source="discovery"]')).not.toBeNull();
    await expect(context.canvasElement.querySelector('[data-feed-source="continue"]')).toBeNull();
    await expect(within(context.canvasElement).queryByRole('button', { name: m.home_feed_following() })).toBeNull();
  },
};
export const PartialSources: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="partial" />,
  play: pageReady,
};
export const Preparing: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="preparing" />,
  play: pageReady,
};
export const Unavailable: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="unavailable" />,
  play: pageReady,
};
export const Empty: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="empty" />,
  play: pageReady,
};
export const Following: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const { userEvent } = await import('storybook/test');
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    const following = await canvas.findByRole('button', { name: m.home_feed_following() });
    await expect(following).toBeEnabled();
    await userEvent.click(following);
    await expect(await canvas.findByRole('link', { name: 'Books I come back to' })).toBeVisible();
    await expect(context.canvasElement.querySelector('[data-feed-source="discovery"]')).toBeNull();
  },
};
