import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookmarkIcon, CompassIcon, HomeIcon, InboxIcon, LibraryIcon } from 'lucide-react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withTheme } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTrigger,
} from './drawer.tsx';

const meta = {
  title: 'Rezics UI/Drawer',
  component: Drawer,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    docs: {
      description: {
        component:
          'A swipeable panel for phones. On REZICS it carries the shelf actions for a Work (Want to read, Reading, Read), quick replies, and the left navigation that the bottom navigation replaces on small screens. It follows the finger, supports snap points and dismisses by swipe, Escape or the backdrop. On desktop prefer a dialog, sheet or popover.',
      },
      story: { inline: false, iframeHeight: 600 },
    },
  },
} satisfies Meta<typeof Drawer>;
export default meta;
type Story = StoryObj<typeof meta>;

const shelves = ['Want to read', 'Reading', 'Read', 'Did not finish'];

const ShelfDrawer = (props: React.ComponentProps<typeof Drawer>) => (
  <Drawer {...props}>
    <DrawerTrigger asChild>
      <Button>Add to shelf</Button>
    </DrawerTrigger>
    <DrawerContent>
      <DrawerHeader
        description="Liu Cixin · translated by Ken Liu · 2014"
        title="The Three-Body Problem"
      />
      <DrawerBody>
        <div className="flex flex-col gap-2">
          {shelves.map((shelf) => (
            <DrawerClose asChild key={shelf}>
              <Button className="w-full" variant={shelf === 'Reading' ? 'soft' : 'outline'}>
                {shelf}
              </Button>
            </DrawerClose>
          ))}
        </div>
      </DrawerBody>
    </DrawerContent>
  </Drawer>
);

const openDrawer = async (canvasElement: HTMLElement, name = 'Add to shelf') => {
  await userEvent.click(within(canvasElement).getByRole('button', { name }));
  return settled(await screen.findByRole('dialog'));
};

export const Bottom: Story = {
  render: () => <ShelfDrawer />,
  async play({ canvasElement }) {
    const drawer = await openDrawer(canvasElement);
    await expect(
      within(drawer).getByRole('heading', { name: 'The Three-Body Problem' }),
    ).toBeVisible();
  },
};

export const CloseWithEscape: Story = {
  render: () => <ShelfDrawer />,
  async play({ canvasElement }) {
    await openDrawer(canvasElement);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  },
};

export const ChooseShelf: Story = {
  render: () => <ShelfDrawer />,
  async play({ canvasElement }) {
    const drawer = await openDrawer(canvasElement);
    await userEvent.click(within(drawer).getByRole('button', { name: 'Read' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  },
};

export const SnapPoints: Story = {
  render: () => <ShelfDrawer defaultSnapPoint={0.5} snapPoints={[0.5, 1]} />,
  play: Bottom.play,
};

const navigation = [
  [HomeIcon, 'Home'],
  [CompassIcon, 'Discover'],
  [InboxIcon, 'Inbox'],
  [LibraryIcon, 'Shelves'],
  [BookmarkIcon, 'Saved posts'],
] as const;

export const StartNavigation: Story = {
  render: () => (
    <Drawer swipeDirection="start">
      <DrawerTrigger asChild>
        <Button variant="outline">Menu</Button>
      </DrawerTrigger>
      <DrawerContent showCloseButton>
        <DrawerHeader className="text-start" title="REZICS" />
        <DrawerBody className="text-start">
          <nav aria-label="Main" className="flex flex-col gap-1">
            {navigation.map(([Icon, label]) => (
              <Button className="justify-start" key={label} variant="ghost">
                <Icon aria-hidden />
                {label}
              </Button>
            ))}
          </nav>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  ),
  async play({ canvasElement }) {
    const drawer = await openDrawer(canvasElement, 'Menu');
    await expect(within(drawer).getByRole('navigation', { name: 'Main' })).toBeVisible();
  },
};

export const CloseWithButton: Story = {
  render: StartNavigation.render,
  async play({ canvasElement }) {
    const drawer = await openDrawer(canvasElement, 'Menu');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  },
};

export const Top: Story = {
  render: () => <ShelfDrawer swipeDirection="up" />,
  play: Bottom.play,
};

export const InsetWithFooter: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button variant="outline">Reply</Button>
      </DrawerTrigger>
      <DrawerContent variant="inset">
        <DrawerHeader
          description="Replying to @ye_wenjie in “Is the dark forest hypothesis still convincing?”"
          title="Quick reply"
        />
        <DrawerBody className="text-start text-sm">
          The dark forest reads better as a thought experiment about trust than as a prediction. The
          sequel’s deterrence arc makes that explicit.
        </DrawerBody>
        <DrawerFooter>
          <Button>Post reply</Button>
          <DrawerClose asChild>
            <Button variant="outline">Save draft</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  ),
  async play({ canvasElement }) {
    const drawer = await openDrawer(canvasElement, 'Reply');
    await expect(within(drawer).getByRole('button', { name: 'Post reply' })).toBeVisible();
  },
};

export const Chinese: Story = {
  render: () => (
    <Drawer>
      <DrawerTrigger asChild>
        <Button>加入书架</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader description="刘慈欣 · 重庆出版社 · 2008" title="《三体》" />
        <DrawerBody>
          <div className="flex flex-col gap-2">
            {['想读', '在读', '读过', '弃读'].map((shelf) => (
              <DrawerClose asChild key={shelf}>
                <Button className="w-full" variant="outline">
                  {shelf}
                </Button>
              </DrawerClose>
            ))}
          </div>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  ),
  async play({ canvasElement }) {
    const drawer = await openDrawer(canvasElement, '加入书架');
    await expect(within(drawer).getByRole('button', { name: '在读' })).toBeVisible();
  },
};

export const Dark: Story = {
  ...Bottom,
  parameters: { theme: 'dark' },
};
