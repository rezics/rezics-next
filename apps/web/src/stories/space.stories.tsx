import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import realmBoardsRecording from '../kernel/recorded/realm-boards.json';
import spaceRecording from '../kernel/recorded/space.json';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Community/Space', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The Space's title, the Realm's boards and a published subject are on the page. */
async function spaceReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: spaceRecording.space.title });
  const board = realmBoardsRecording.items[0]?.title;
  if (!board) throw new Error('The recorded Realm has no board.');
  await view.findByRole('link', { name: new RegExp(board) });
  const firstRow = (await view.findAllByRole('listitem'))[0]!;
  await userEvent.hover(firstRow);
  firstRow.setAttribute('data-overlay', 'visible');
}

export const SignedIn: Story = {
  name: 'Banner, Non-member',
  play: spaceReady,
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-non-member" />,
};
export const SignedOut: Story = {
  name: 'Banner, Signed Out',
  play: spaceReady,
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-banner" />,
};
export const NoBanner: Story = {
  name: 'No Banner',
  play: spaceReady,
  render: () => <PageStory visitor="Signed Out" path="/spaces/atlas-plain" />,
};
export const Member: Story = {
  name: 'Banner, Member',
  play: spaceReady,
  render: () => <PageStory visitor="Signed In" path="/spaces/atlas-member" />,
};
