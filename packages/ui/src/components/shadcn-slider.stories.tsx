import type { Meta, StoryObj } from '@storybook/react-vite';
import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { expect, userEvent, within } from 'storybook/test';
import { Label } from '@rezics/ui/shadcn/label';
import { Slider } from '@rezics/ui/shadcn/slider';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Slider',
  component: Slider,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: {
    docs: {
      description: {
        component:
          'Use aria-labelledby with a visible label and locale/format for numeric values. For distinct thumb names or custom value text, compose Base UI slider parts directly, as the named examples show.',
      },
    },
  },
  render: (args) => (
    <div className="grid max-w-sm gap-3">
      <Label id="slider-story-label">Rating</Label>
      <Slider aria-labelledby="slider-story-label" {...args} />
    </div>
  ),
} satisfies Meta<typeof Slider>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { defaultValue: [40], min: 0, max: 100, step: 10 },
  async play({ canvasElement }) {
    const thumb = within(canvasElement).getByRole('slider');
    await expect(thumb).toHaveValue('40');
    thumb.focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(thumb).toHaveValue('50');
    await userEvent.keyboard('{End}');
    await expect(thumb).toHaveValue('100');
  },
};

export const Range: Story = {
  args: { defaultValue: [20, 70] },
  async play({ canvasElement }) {
    const thumbs = within(canvasElement).getAllByRole('slider');
    await expect(thumbs).toHaveLength(2);
    await expect(thumbs[0]).toHaveValue('20');
    await expect(thumbs[1]).toHaveValue('70');
  },
};

export const Disabled: Story = {
  args: { defaultValue: [60], disabled: true },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('slider')).toBeDisabled();
  },
};

export const Vertical: Story = {
  args: { defaultValue: [30], orientation: 'vertical' },
  render: (args) => (
    <div className="grid h-48 gap-3">
      <Label id="slider-volume">Volume</Label>
      <Slider aria-labelledby="slider-volume" {...args} />
    </div>
  ),
  async play({ canvasElement }) {
    const thumb = within(canvasElement).getByRole('slider', { name: 'Volume' });
    await expect(thumb).toHaveAttribute('aria-orientation', 'vertical');
    thumb.focus();
    await userEvent.keyboard('{ArrowUp}');
    await expect(thumb).toHaveValue('31');
  },
};

const controlClass = 'relative flex min-h-11 w-full touch-none items-center select-none data-disabled:opacity-50';
const trackClass = 'relative h-1 w-full grow overflow-hidden rounded-2xl bg-input/90';
const thumbClass =
  'block size-4 shrink-0 rounded-2xl bg-white shadow-md ring-1 ring-black/10 hover:ring-4 hover:ring-ring/30 focus-visible:ring-4 focus-visible:ring-ring/30 focus-visible:outline-hidden';

export const NamedSingle: Story = {
  args: { defaultValue: [40], step: 10 },
  render: (args) => (
    <SliderPrimitive.Root {...args} className="grid w-full max-w-sm gap-3" thumbAlignment="edge">
      <SliderPrimitive.Label>Rating</SliderPrimitive.Label>
      <SliderPrimitive.Control className={controlClass}>
        <SliderPrimitive.Track className={trackClass}>
          <SliderPrimitive.Indicator className="h-full bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label="Rating"
          getAriaValueText={(_formatted, value) => `${value} points`}
          className={thumbClass}
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const input = canvas.getByRole('slider', { name: 'Rating' });
    await expect(input).toHaveAttribute('type', 'range');
    await expect(input).toHaveAttribute('aria-valuetext', '40 points');
    await expect(canvas.getByRole('group')).not.toHaveAttribute('aria-valuetext');
    input.focus();
    await userEvent.keyboard('{ArrowRight}{End}{Home}');
    await expect(input).toHaveValue('0');
    await expect(input).toHaveAttribute('aria-valuetext', '0 points');
  },
};

export const NamedRange: Story = {
  args: { defaultValue: [20, 70] },
  render: (args) => (
    <SliderPrimitive.Root {...args} className="grid w-full max-w-sm gap-3" thumbAlignment="edge">
      <SliderPrimitive.Label>Rating range</SliderPrimitive.Label>
      <SliderPrimitive.Control className={controlClass}>
        <SliderPrimitive.Track className={trackClass}>
          <SliderPrimitive.Indicator className="h-full bg-primary" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          index={0}
          aria-label="Minimum rating"
          getAriaValueText={(_formatted, value) => `From ${value} points`}
          className={thumbClass}
        />
        <SliderPrimitive.Thumb
          index={1}
          aria-label="Maximum rating"
          getAriaValueText={(_formatted, value) => `Through ${value} points`}
          className={thumbClass}
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const minimum = canvas.getByRole('slider', { name: 'Minimum rating' });
    const maximum = canvas.getByRole('slider', { name: 'Maximum rating' });
    await expect(canvas.getAllByRole('slider')).toHaveLength(2);
    await expect(minimum).toHaveValue('20');
    await expect(maximum).toHaveValue('70');
    await expect(minimum).toHaveAttribute('aria-valuetext', 'From 20 points');
    await expect(maximum).toHaveAttribute('aria-valuetext', 'Through 70 points');
    maximum.focus();
    await userEvent.keyboard('{ArrowLeft}');
    await expect(maximum).toHaveValue('69');
    await expect(maximum).toHaveAttribute('aria-valuetext', 'Through 69 points');
    await expect(minimum).toHaveValue('20');
  },
};
