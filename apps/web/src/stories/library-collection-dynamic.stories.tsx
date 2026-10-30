import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory } from './page';
import { pageReady } from './page';

const meta = {
  title: 'Pages/Library/Collection',
  parameters: { layout: 'fullscreen' },
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
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-preparing`} />,
};

export const Unavailable: Story = {
  name: 'Signed out, unavailable',
  play: pageReady,
  render: () => <PageStory visitor="Signed Out" path={`/collections/dynamic-unavailable`} />,
};
