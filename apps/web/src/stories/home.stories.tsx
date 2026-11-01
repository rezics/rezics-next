import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
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
    await waitFor(() =>
      expect(
        canvas.getByRole('combobox', { name: m.home_kind_label() }).querySelector('option[value="schema:Book"]'),
      ).not.toBeNull(),
    );
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.home_kind_label() }), 'schema:Book');
    await expect(canvas.getByRole('combobox', { name: m.home_kind_label() })).toHaveValue('schema:Book');
    await waitFor(() => expect(context.canvasElement.querySelector('[data-feed-source="continue"]')).not.toBeNull());
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
    await waitFor(() =>
      expect(
        canvas.getByRole('combobox', { name: m.home_kind_label() }).querySelector('option[value="schema:Book"]'),
      ).not.toBeNull(),
    );
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: m.home_kind_label() }), 'schema:Book');
    await waitFor(() => expect(context.canvasElement.querySelector('[data-feed-source="continue"]')).not.toBeNull());
    await userEvent.click(canvas.getByRole('button', { name: m.home_kinds_next() }));
    await waitFor(() =>
      expect(
        canvas.getByRole('combobox', { name: m.home_kind_label() }).querySelector('option[value="account"]'),
      ).not.toBeNull(),
    );
    await expect(canvas.getByRole('combobox', { name: m.home_kind_label() })).toHaveValue('schema:Book');
  },
};

// Interactive source stories: use the actual exact-address control; no synthetic native-proof claim.
export const SpaceSelection: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Look up home-reading-room, review its current title/address, then use the Space. Next, retry, refresh and clear use the default Home consumer.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="space-selection" />,
};
export const SpaceUnavailable: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Look up home-reading-room. Its illustrative native point response has no readable Realm; it cannot be selected or treated as an empty feed.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="space-unavailable" />,
};
export const SpaceIdentityChanged: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Look up and select home-reading-room, then refresh. The Realm changes independently while the head remains equal, retiring the displayed page and cursor.',
      },
    },
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.home} homeFeedFixture="space-identity-changed" />,
};
