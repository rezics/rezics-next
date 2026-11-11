import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { ChoiceSelect } from './choice-select.tsx';
import { FieldDescription } from '@rezics/ui/shadcn/field';
import { Select } from '@rezics/ui/shadcn/select';
import { settled, withSurface } from '../stories/support.tsx';

const shelves = [
  { value: null, label: 'Choose a shelf' },
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
    <form data-testid="select-form" className="max-w-xs">
      <ChoiceSelect
        label="Shelf"
        name="shelf"
        options={shelves}
        value={value}
        onValueChange={setValue}
        placeholder="Choose a shelf"
      />
      <FieldDescription>Where the Work appears on your profile.</FieldDescription>
    </form>
  );
};

export const Default: Story = {
  render: () => <ShelfSelect />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('combobox', { name: 'Shelf' });
    await expect(trigger).toHaveTextContent('Choose a shelf');
    const form = within(canvasElement).getByTestId('select-form') as HTMLFormElement;
    await expect(new FormData(form).get('shelf')).toBe('');
    await userEvent.click(trigger);
    const listbox = await settled(await screen.findByRole('listbox'));
    await userEvent.click(within(listbox).getByRole('option', { name: 'Currently reading' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(trigger).toHaveTextContent('Currently reading');
    await expect(new FormData(form).get('shelf')).toBe('reading');
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
