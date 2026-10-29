import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import myRealmsRecording from '../kernel/recorded/my-realms.json';
import { PageStory, pageReady } from './page';

const meta = { title: 'Pages/Realms', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function mainView(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = within(within(context.canvasElement).getByRole('main'));
  await view.findByRole('heading', { level: 1 });
  return view;
}

/** The signed-in person's first Realm is listed with a link. */
async function listed(context: { canvasElement: HTMLElement }) {
  const view = await mainView(context);
  const name = myRealmsRecording.items[0]?.name;
  if (!name) throw new Error('The recorded Realms page has no Realm.');
  const link = await view.findByRole('link', { name });
  await userEvent.hover(link);
  link.closest('[data-slot="list-row"]')?.setAttribute('data-overlay', 'visible');
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: listed,
  render: () => <PageStory visitor="Signed In" path="/realms" />,
};
