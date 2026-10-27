import type { Meta, StoryObj } from '@storybook/react-vite';
import { within } from 'storybook/test';
import realmBoardsRecording from '../kernel/recorded/realm-boards.json';
import spaceRecording from '../kernel/recorded/space.json';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Space', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const path = `/spaces/${spaceRecording.space.address}`;

/** The Space's title, the Realm's boards and a published subject are on the page. */
async function spaceReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1, name: spaceRecording.space.title });
  const board = realmBoardsRecording.items[0]?.title;
  if (!board) throw new Error('The recorded Realm has no board.');
  await view.findByRole('link', { name: new RegExp(board) });
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: spaceReady,
  render: () => <PageStory visitor="Signed In" path={path} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: spaceReady,
  render: () => <PageStory visitor="Signed Out" path={path} />,
};
