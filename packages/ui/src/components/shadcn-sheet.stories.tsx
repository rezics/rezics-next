import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@rezics/ui/shadcn/sheet';
import { waitForFocus } from '../test/focus.ts';
import { dismissed, settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Sheet',
  component: Sheet,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 520 } } },
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

const Filters = ({ side }: { side?: 'top' | 'right' | 'bottom' | 'left' }) => (
  <Sheet>
    <SheetTrigger render={<Button variant="outline" />}>Filters</SheetTrigger>
    <SheetContent side={side}>
      <SheetHeader>
        <SheetTitle>Filter Works</SheetTitle>
        <SheetDescription>Narrow the list by author or title.</SheetDescription>
      </SheetHeader>
      <div className="px-6">
        <Field>
          <FieldLabel htmlFor="sheet-author">Author</FieldLabel>
          <Input id="sheet-author" defaultValue="刘慈欣" />
        </Field>
      </div>
      <SheetFooter>
        <Button>Apply filters</Button>
        <SheetClose render={<Button variant="outline" />}>Cancel</SheetClose>
      </SheetFooter>
    </SheetContent>
  </Sheet>
);

export const Default: Story = {
  render: () => <Filters />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Filters' });
    await userEvent.click(trigger);
    const sheet = await settled(await screen.findByRole('dialog', { name: 'Filter Works' }));
    await expect(sheet).toHaveAccessibleDescription('Narrow the list by author or title.');
    await expect(sheet).toHaveAttribute('data-side', 'right');
    await userEvent.keyboard('{Escape}');
    await dismissed('dialog');
    await waitForFocus(trigger);
  },
};

export const Sides: Story = {
  render: () => <Filters side="left" />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filters' }));
    const sheet = await settled(await screen.findByRole('dialog'));
    await expect(sheet).toHaveAttribute('data-side', 'left');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await dismissed('dialog');
  },
};

export const Bottom: Story = {
  render: () => <Filters side="bottom" />,
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filters' }));
    const sheet = await settled(await screen.findByRole('dialog'));
    await expect(sheet).toHaveAttribute('data-side', 'bottom');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await dismissed('dialog');
  },
};

export const LongCJKContent: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" />}>作品详情</SheetTrigger>
      <SheetContent showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>《三体》第三部：死神永生与更多的长标题作品名称</SheetTitle>
          <SheetDescription>
            文明之间的黑暗森林法则：宇宙就是一座黑暗森林，每个文明都是带枪的猎人，像幽灵般潜行于林间。
          </SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <SheetClose render={<Button variant="outline" />}>关闭</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '作品详情' }));
    const sheet = await settled(await screen.findByRole('dialog', { name: /死神永生/ }));
    await expect(within(sheet).queryByRole('button', { name: 'Close' })).toBeNull();
    await userEvent.click(within(sheet).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  },
};
