import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent } from 'storybook/test';
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

export const KindSelection: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    await userEvent.click(await canvas.findByRole('button', { name: m.home_kinds_load() }));
    await canvas.findByRole('option', { name: 'Book' });
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.home_kind_label() }), 'schema:Book');
    await expect(canvas.getByRole('combobox', { name: m.home_kind_label() })).toHaveValue('schema:Book');
    await expect(await canvas.findByRole('link', { name: 'The Little Prince' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Letters from B-612' })).toBeNull();
  },
};
export const KindChoicesUnavailable: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="kinds-unavailable" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    await userEvent.click(await canvas.findByRole('button', { name: m.home_kinds_load() }));
    await expect(await canvas.findByText(m.home_kinds_unavailable())).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Letters from B-612' })).toBeVisible();
  },
};
export const KindChoicesNextPage: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="kinds-next" />,
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await canvas.findByRole('link', { name: 'Letters from B-612' });
    await userEvent.click(await canvas.findByRole('button', { name: m.home_kinds_load() }));
    await canvas.findByRole('option', { name: 'Book' });
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.home_kind_label() }), 'schema:Book');
    await canvas.findByRole('link', { name: 'The Little Prince' });
    await userEvent.click(canvas.getByRole('button', { name: m.home_kinds_next() }));
    await expect(await canvas.findByRole('option', { name: 'Account' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: m.home_kind_label() })).toHaveValue('schema:Book');
  },
};
