import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Field, FieldDescription, FieldLabel } from '@rezics/ui/shadcn/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@rezics/ui/shadcn/select';
import { settled, withSurface } from '../stories/support.tsx';

const shelves = [
  { value: 'want', label: 'Want to read' },
  { value: 'reading', label: 'Currently reading' },
  { value: 'read', label: 'Read' },
];

const meta = {
  title: 'shadcn/Select',
  component: Select,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
} satisfies Meta<typeof Select>;
export default meta;
type Story = StoryObj<typeof meta>;

const ShelfSelect = ({ defaultValue }: { defaultValue?: string }) => {
  const [value, setValue] = useState<string | null>(defaultValue ?? null);
  return (
    <Field className="max-w-xs">
      <FieldLabel id="shelf-label">Shelf</FieldLabel>
      <Select items={shelves} value={value} onValueChange={setValue}>
        <SelectTrigger aria-labelledby="shelf-label" className="w-full">
          <SelectValue placeholder="Choose a shelf" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Shelves</SelectLabel>
            {shelves.map((shelf) => (
              <SelectItem key={shelf.value} value={shelf.value}>
                {shelf.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription>Where the Work appears on your profile.</FieldDescription>
    </Field>
  );
};

export const Default: Story = {
  render: () => <ShelfSelect />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('combobox', { name: 'Shelf' });
    await expect(trigger).toHaveTextContent('Choose a shelf');
    await userEvent.click(trigger);
    const listbox = await settled(await screen.findByRole('listbox'));
    await userEvent.click(within(listbox).getByRole('option', { name: 'Currently reading' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(trigger).toHaveTextContent('Currently reading');
  },
};

export const Selected: Story = {
  render: () => <ShelfSelect defaultValue="read" />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox', { name: 'Shelf' })).toHaveTextContent('Read');
  },
};

export const Keyboard: Story = {
  render: () => <ShelfSelect />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('combobox', { name: 'Shelf' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await settled(await screen.findByRole('listbox'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(trigger).toHaveFocus();
  },
};
