import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from './page';
import { pageReady } from './page';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';

const meta = {
  title: 'Pages/Library/Dynamic Collection',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Settled dynamic read states; phone390/desktop1280 and locale/theme globals. Web story review and Root screenshot review PENDING.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Everything: Story = {
  name: 'Signed out, Everything collection',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-everything`} />,
};

export const Liked: Story = {
  name: 'Signed out, Liked collection',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-liked`} />,
};

export const State: Story = {
  name: 'Signed out, state selected',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state`} />,
};

export const EmptyEverything: Story = {
  name: 'Signed out, Everything empty',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-empty`} />,
};

export const RenamedEverything: Story = {
  name: 'Signed out, renamed collection',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-renamed`} />,
};

export const StateOther: Story = {
  name: 'Signed out, alternate state selected',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-state-other`} />,
};

export const Paged: Story = {
  name: 'Signed out, later collection page',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-paged`} />,
};

export const Preparing: Story = {
  name: 'Signed out, preparing',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_dynamic_preparing())).toBeVisible();
    await expect(canvas.queryByText(m.library_dynamic_empty_everything())).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};

export const Unavailable: Story = {
  name: 'Signed out, unavailable',
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_dynamic_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.library_dynamic_empty_everything())).toBeNull();
  },
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
