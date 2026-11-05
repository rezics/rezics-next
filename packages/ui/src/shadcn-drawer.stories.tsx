import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@rezics/ui/shadcn/drawer';
import { waitForFocus } from './test/focus.ts';
import { settled, withSurface } from './stories/support.tsx';

const meta = {
  title: 'shadcn/Drawer',
  component: Drawer,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 560 } } },
} satisfies Meta<typeof Drawer>;
export default meta;
type Story = StoryObj<typeof meta>;

const gone = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 15000 });

const FilterDrawer = ({
  swipeDirection,
  title = 'Filter Works',
  description = 'Narrow the list by language, length and reading status.',
  trigger = 'Filters',
}: {
  swipeDirection?: 'down' | 'up' | 'left' | 'right';
  title?: string;
  description?: string;
  trigger?: string;
}) => (
  <Drawer swipeDirection={swipeDirection} showSwipeHandle={swipeDirection === undefined || swipeDirection === 'down'}>
    <DrawerTrigger render={<Button variant="outline" />}>{trigger}</DrawerTrigger>
    <DrawerContent>
      <DrawerHeader>
        <DrawerTitle>{title}</DrawerTitle>
        <DrawerDescription>{description}</DrawerDescription>
      </DrawerHeader>
      <DrawerFooter>
        <Button>Apply filters</Button>
        <DrawerClose render={<Button variant="outline" />}>Cancel</DrawerClose>
      </DrawerFooter>
    </DrawerContent>
  </Drawer>
);

export const Default: Story = {
  render: () => <FilterDrawer />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Filters' });
    await userEvent.click(trigger);
    const drawer = await settled(await screen.findByRole('dialog', { name: 'Filter Works' }));
    await expect(drawer).toHaveAccessibleDescription(/Narrow the list/);
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{Escape}');
    await gone();
    await waitForFocus(trigger);
  },
};

export const CloseButton: Story = {
  render: () => <FilterDrawer />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filters' }));
    const drawer = await settled(await screen.findByRole('dialog'));
    await userEvent.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    await gone();
  },
};

export const FromTheSide: Story = {
  render: () => <FilterDrawer swipeDirection="right" />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filters' }));
    const drawer = await settled(await screen.findByRole('dialog', { name: 'Filter Works' }));
    await expect(drawer).toHaveAttribute('data-swipe-direction', 'right');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Apply filters' }));
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <FilterDrawer
      trigger="篩選條件"
      title="依語言、篇幅與閱讀狀態篩選作品，並儲存為常用的檢視設定"
      description="選擇之後列表會立即更新；你也可以把目前的條件另存為檢視，下次從書架上直接開啟，不需要重新設定每一個選項，也不會影響其他人看到的內容。"
    />
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '篩選條件' }));
    const drawer = await settled(await screen.findByRole('dialog', { name: /依語言、篇幅/ }));
    await expect(within(drawer).getByText(/不需要重新設定/)).toBeVisible();
  },
};
