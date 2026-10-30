import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import boardRealmRecording from '../kernel/recorded/board-realm.json';
import boardRealmRealmRecording from '../kernel/recorded/board-realm-realm.json';
import boardRealmThreadRecording from '../kernel/recorded/board-realm-thread.json';
import { m } from '../paraglide/messages.js';
import { threadHref } from '../threads/thread-href';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Community/Realm Board', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** The line above the title names the Realm, then the board on a thread page; each is a link. */
function crumbReady(heading: string, names: readonly string[]) {
  return async (context: { canvasElement: HTMLElement }) => {
    await pageReady(context);
    const view = within(within(context.canvasElement).getByRole('main'));
    const title = await view.findByRole('heading', { level: 1, name: heading });
    const line = await view.findByRole('navigation', { name: m.board_context_label() });
    for (const name of names) await within(line).findByRole('link', { name });
    expect(line.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  };
}

const realm = boardRealmRealmRecording.realm.title;
const board = boardRealmRecording.board.title;
const thread = boardRealmThreadRecording.thread.title;
const boardPath = `/boards/${boardRealmRecording.board.id}`;
const threadPath = threadHref(boardRealmThreadRecording.thread);

export const ThreadSignedIn: Story = {
  name: 'Thread Signed In',
  play: crumbReady(thread, [realm, board]),
  render: () => <PageStory visitor="Signed In" path={threadPath} />,
};
export const ThreadSignedOut: Story = {
  name: 'Thread Signed Out',
  play: crumbReady(thread, [realm, board]),
  render: () => <PageStory visitor="Signed Out" path={threadPath} />,
};
export const BoardSignedIn: Story = {
  name: 'Board Signed In',
  play: crumbReady(board, [realm]),
  render: () => <PageStory visitor="Signed In" path={boardPath} />,
};
export const BoardSignedOut: Story = {
  name: 'Board Signed Out',
  play: crumbReady(board, [realm]),
  render: () => <PageStory visitor="Signed Out" path={boardPath} />,
};
