import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerAreaThumb,
  ColorPickerContent,
  ColorPickerInput,
  ColorPickerLabel,
  ColorPickerSlider,
  ColorPickerSwatch,
  ColorPickerSwatchGroup,
  ColorPickerSwatchIndicator,
  ColorPickerSwatchTrigger,
  ColorPickerTrigger,
  ColorPickerValue,
  ColorPickerValueSwatch,
} from './color-picker.tsx';

const palette = [
  { name: 'Ink blue', value: '#2f63ad' },
  { name: 'Logo red', value: '#df3d35' },
  { name: 'Rating gold', value: '#bf7a0e' },
];

const meta = {
  title: 'UI/ColorPicker',
  component: ColorPicker,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'Use a color picker for member-created accents or moderation annotations in REZICS; keep preset brand colors easy to choose and show the selected value in text.',
      },
    },
  },
  decorators: [
    (Story) => (
      <main
        className={'aura-canvas flex min-h-screen items-center justify-center bg-background p-6'}
      >
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof ColorPicker>;

export default meta;
type Story = StoryObj<typeof meta>;

const Picker = ({ dark = false, disabled = false }: { dark?: boolean; disabled?: boolean }) => {
  const [value, setValue] = React.useState('#2f63ad');
  return (
    <div className={dark ? 'rounded-2xl bg-background p-6 text-foreground' : 'p-6'}>
      <div className="grid gap-3">
        <ColorPicker
          defaultValue={value}
          disabled={disabled}
          onValueChange={(details) => setValue(details.valueAsString)}
        >
          <ColorPickerLabel>Realm accent color</ColorPickerLabel>
          <div className="flex items-center gap-3">
            <ColorPickerTrigger
              aria-label="Choose a Realm accent color"
              className="flex h-10 items-center gap-2 rounded-xl border border-border/60 bg-card px-3 text-sm text-foreground shadow-xs/5 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ColorPickerValueSwatch aria-hidden="true" />
              Choose color
            </ColorPickerTrigger>
            <ColorPickerValue className="font-mono text-sm text-muted-foreground" />
          </div>
          <ColorPickerContent aria-label="Choose a Realm accent color">
            <ColorPickerArea aria-label="Choose a shade" showDots>
              <ColorPickerAreaThumb />
            </ColorPickerArea>
            <ColorPickerSlider aria-label="Hue" channel="hue" />
            <ColorPickerInput aria-label="Hex color" channel="hex" />
            <ColorPickerSwatchGroup aria-label="REZICS palette">
              {palette.map((color) => (
                <ColorPickerSwatchTrigger
                  aria-label={color.name}
                  key={color.value}
                  value={color.value}
                >
                  <ColorPickerSwatch value={color.value}>
                    <ColorPickerSwatchIndicator />
                  </ColorPickerSwatch>
                </ColorPickerSwatchTrigger>
              ))}
            </ColorPickerSwatchGroup>
          </ColorPickerContent>
        </ColorPicker>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          Selected value: <span className="font-mono text-foreground">{value}</span>
        </p>
      </div>
    </div>
  );
};

export const Palette: Story = {
  render: () => <Picker />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Realm accent color' }));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole('button', { name: 'Logo red' }));
    await expect(canvas.getByText('Selected value:')).toHaveTextContent('223, 61, 53');
    await userEvent.keyboard('{Escape}');
  },
};

export const Disabled: Story = { render: () => <Picker disabled /> };
export const DarkMode: Story = { globals: { theme: 'dark' }, render: () => <Picker dark /> };
