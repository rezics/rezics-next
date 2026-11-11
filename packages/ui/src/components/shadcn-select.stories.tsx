import type { Meta, StoryObj } from '@storybook/react-vite';
import { useId, useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Field, FieldDescription, FieldLabel } from '../shadcn/field.tsx';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../shadcn/select.tsx';
import { settled, withSurface } from '../stories/support.tsx';

const shelves = [
  { value: null, label: 'Choose a shelf' },
  { value: 'want', label: 'Want to read' },
  { value: 'reading', label: 'Currently reading' },
  { value: 'read', label: 'Read' },
  { value: 'retired', label: 'Unavailable shelf', disabled: true },
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
  const id = useId();
  const [value, setValue] = useState<string | null>(defaultValue ?? null);
  return (
    <form data-testid="select-form" className="max-w-xs">
      <Field>
        <FieldLabel id={`${id}-label`} htmlFor={id}>
          Shelf
        </FieldLabel>
        <Select<string, false> items={shelves} name="shelf" value={value} onValueChange={setValue}>
          <SelectTrigger id={id} aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} className="w-full">
            <SelectValue placeholder="Choose a shelf" />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {shelves.map(({ value, label, ...itemProps }) => (
                <SelectItem key={value ?? ''} value={value} {...itemProps}>
                  {label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription id={`${id}-help`}>Where the Work appears on your profile.</FieldDescription>
      </Field>
    </form>
  );
};

export const Default: Story = {
  render: () => <ShelfSelect />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('combobox', { name: 'Shelf' });
    await expect(trigger).toHaveTextContent('Choose a shelf');
    await expect(trigger).toHaveAccessibleDescription('Where the Work appears on your profile.');
    const form = within(canvasElement).getByTestId('select-form') as HTMLFormElement;
    await expect(new FormData(form).getAll('shelf')).toEqual(['']);
    await userEvent.click(trigger);
    const listbox = await settled(await screen.findByRole('listbox'));
    await expect(within(listbox).getByRole('option', { name: 'Unavailable shelf' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(listbox).getByRole('option', { name: 'Currently reading' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(trigger).toHaveTextContent('Currently reading');
    await expect(new FormData(form).getAll('shelf')).toEqual(['reading']);
    await userEvent.click(trigger);
    await userEvent.click(
      within(await settled(await screen.findByRole('listbox'))).getByRole('option', { name: 'Choose a shelf' }),
    );
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(trigger).toHaveTextContent('Choose a shelf');
    await expect(new FormData(form).getAll('shelf')).toEqual(['']);
  },
};

export const Selected: Story = {
  render: () => <ShelfSelect defaultValue="read" />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('combobox', { name: 'Shelf' })).toHaveTextContent('Read');
    const form = within(canvasElement).getByTestId('select-form') as HTMLFormElement;
    await expect(new FormData(form).getAll('shelf')).toEqual(['read']);
  },
};

export const Keyboard: Story = {
  render: () => <ShelfSelect />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('combobox', { name: 'Shelf' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    await settled(await screen.findByRole('listbox'));
    await userEvent.keyboard('{Home}{ArrowDown}{Enter}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(trigger).toHaveTextContent('Want to read');
    await expect(trigger).toHaveFocus();
    const form = within(canvasElement).getByTestId('select-form') as HTMLFormElement;
    await expect(new FormData(form).getAll('shelf')).toEqual(['want']);
    await userEvent.keyboard('{Enter}');
    await settled(await screen.findByRole('listbox'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await expect(trigger).toHaveFocus();
    await expect(trigger).toHaveTextContent('Want to read');
  },
};
