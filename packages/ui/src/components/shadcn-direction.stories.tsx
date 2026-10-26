import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { DirectionProvider, useDirection } from '@rezics/ui/shadcn/direction';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { Slider } from '@rezics/ui/shadcn/slider';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Direction',
  component: DirectionProvider,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof DirectionProvider>;
export default meta;
type Story = StoryObj<typeof meta>;

const Current = () => <p data-testid="direction">Direction: {useDirection()}</p>;

export const Ltr: Story = {
  args: { direction: 'ltr' },
  render: (args) => (
    <DirectionProvider {...args}>
      <div dir="ltr" className="grid max-w-sm gap-2">
        <Current />
        <Label htmlFor="direction-ltr">Shelf name</Label>
        <Input id="direction-ltr" defaultValue="Hard science fiction" />
        <Button>Save</Button>
      </div>
    </DirectionProvider>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByTestId('direction')).toHaveTextContent('Direction: ltr');
  },
};

export const Rtl: Story = {
  args: { direction: 'rtl' },
  render: (args) => (
    <DirectionProvider {...args}>
      <div dir="rtl" lang="ar" className="grid max-w-sm gap-2">
        <Current />
        <Label htmlFor="direction-rtl">اسم الرف</Label>
        <Input id="direction-rtl" defaultValue="الخيال العلمي الصلب" />
        <Button>حفظ</Button>
      </div>
    </DirectionProvider>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('direction')).toHaveTextContent('Direction: rtl');
    await expect(canvas.getByRole('textbox', { name: 'اسم الرف' })).toHaveValue('الخيال العلمي الصلب');
  },
};

const Rating = ({ direction, label }: { direction: 'ltr' | 'rtl'; label: string }) => (
  <DirectionProvider direction={direction}>
    <div dir={direction} className="grid max-w-xs gap-2">
      <Label id={`rating-${direction}`}>{label}</Label>
      <Slider aria-labelledby={`rating-${direction}`} defaultValue={[5]} min={0} max={10} />
    </div>
  </DirectionProvider>
);

export const KeyboardFollowsDirection: Story = {
  render: () => (
    <div className="grid gap-6">
      <Rating direction="ltr" label="Rating" />
      <Rating direction="rtl" label="التقييم" />
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    // ArrowRight raises the value in left-to-right layouts and lowers it in right-to-left ones.
    const ltr = canvas.getByRole('slider', { name: 'Rating' });
    ltr.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(ltr).toHaveValue('6');
    const rtl = canvas.getByRole('slider', { name: 'التقييم' });
    rtl.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(rtl).toHaveValue('4');
  },
};
