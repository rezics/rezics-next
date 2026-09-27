import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Slider, SliderLabel, SliderValue } from './slider.tsx';

const meta = {
  title: 'Rezics UI/Slider',
  component: Slider,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Picks a value or a range by dragging or with arrow, Page and Home/End keys. In REZICS use it for filters where the exact number matters less than the feel: minimum average rating and publication-year range in Work search, reading progress on a shelf entry, and text size in the reader. Pass two values for a range; show the current value with SliderValue.',
      },
    },
  },
  args: { defaultValue: [62] },
  decorators: [
    (Story, { parameters }) => (
      <div className={cn(parameters.theme === 'dark' && 'dark')}>
        <div className="min-h-40 bg-background p-6 font-sans text-foreground">
          <div className="flex max-w-sm flex-col gap-8">
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <Slider {...args}>
      <div className="flex">
        <SliderLabel>Reading progress (%)</SliderLabel>
        <SliderValue />
      </div>
    </Slider>
  ),
} satisfies Meta<typeof Slider>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const thumb = canvas.getByRole('slider', { name: 'Reading progress (%)' });
    await expect(canvas.getAllByRole('slider')).toHaveLength(1);
    await expect(thumb).toHaveAttribute('aria-valuenow', '62');
    thumb.focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(thumb).toHaveAttribute('aria-valuenow', '64'));
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(thumb).toHaveAttribute('aria-valuenow', '100'));
  },
};

export const NoValue: Story = { args: { defaultValue: undefined } };

export const Range: Story = {
  args: { defaultValue: [1965, 2008], min: 1900, max: 2026 },
  render: (args) => (
    <Slider {...args}>
      <div className="flex">
        <SliderLabel>First published</SliderLabel>
        <SliderValue />
      </div>
    </Slider>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('slider')).toHaveLength(2);
  },
};

export const Markers: Story = {
  args: { defaultValue: [7], min: 1, max: 10, showMarkers: true },
  render: (args) => (
    <Slider {...args}>
      <div className="flex">
        <SliderLabel>Minimum Realm review score</SliderLabel>
        <SliderValue />
      </div>
    </Slider>
  ),
};

export const MarkerLabels: Story = {
  args: {
    defaultValue: [2],
    min: 0,
    max: 4,
    showMarkers: true,
    markerLabels: ['XS', 'S', 'M', 'L', 'XL'],
  },
  render: (args) => (
    <Slider {...args}>
      <SliderLabel>Reader text size</SliderLabel>
    </Slider>
  ),
};

export const Stepped: Story = {
  args: { defaultValue: [3.5], min: 0, max: 5, step: 0.5 },
  render: (args) => (
    <Slider {...args}>
      <div className="flex">
        <SliderLabel>Minimum average rating</SliderLabel>
        <SliderValue />
      </div>
    </Slider>
  ),
};

export const Vertical: Story = {
  args: { orientation: 'vertical', defaultValue: [40] },
  render: (args) => (
    <div className="h-48">
      <Slider {...args}>
        <SliderLabel>Volume</SliderLabel>
      </Slider>
    </div>
  ),
};

export const Disabled: Story = { args: { disabled: true } };

export const Chinese: Story = {
  args: { defaultValue: [3.5, 5], min: 0, max: 5, step: 0.5 },
  render: (args) => (
    <Slider {...args}>
      <div className="flex">
        <SliderLabel>平均评分范围</SliderLabel>
        <SliderValue />
      </div>
    </Slider>
  ),
};

export const Dark: Story = {
  parameters: { theme: 'dark' },
  render: (args, context) => (
    <>
      {meta.render(args)}
      {Range.render?.({ ...args, ...Range.args }, context)}
      {Markers.render?.({ ...args, ...Markers.args }, context)}
      {meta.render({ ...args, disabled: true })}
    </>
  ),
};
