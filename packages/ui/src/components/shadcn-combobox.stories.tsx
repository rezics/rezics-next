import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from '@rezics/ui/shadcn/combobox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Combobox',
  component: Combobox,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 420 } } },
} satisfies Meta<typeof Combobox>;
export default meta;
type Story = StoryObj<typeof meta>;

const works = ['Dune', 'Hyperion', 'Neuromancer', 'Solaris', '三體', 'Kokoro（こころ）'];

const gone = () => waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

const WorkPicker = ({
  items = works,
  disabled,
  ...props
}: { items?: string[] } & Partial<React.ComponentProps<typeof Combobox>>) => (
  <Field className="max-w-xs">
    <FieldLabel htmlFor="combobox-work">Related Work</FieldLabel>
    <Combobox items={items} disabled={disabled} {...props}>
      <ComboboxInput id="combobox-work" placeholder="Search Works" disabled={disabled} showTrigger={false} />
      <ComboboxContent>
        <ComboboxEmpty>No Works found.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  </Field>
);

export const Default: Story = {
  render: () => <WorkPicker />,
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('combobox', { name: 'Related Work' });
    await userEvent.type(input, 'sol');
    const listbox = await settled(await screen.findByRole('listbox'));
    await waitFor(() => expect(within(listbox).getAllByRole('option')).toHaveLength(1));
    await userEvent.click(within(listbox).getByRole('option', { name: 'Solaris' }));
    await gone();
    await waitFor(() => expect(input).toHaveValue('Solaris'));
  },
};

export const KeyboardSelection: Story = {
  render: () => <WorkPicker />,
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('combobox', { name: 'Related Work' });
    input.focus();
    await userEvent.keyboard('{ArrowDown}');
    await settled(await screen.findByRole('listbox'));
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await gone();
    await waitFor(() => expect(input).not.toHaveValue(''));
    await userEvent.keyboard('{Escape}');
  },
};

export const NoResults: Story = {
  render: () => <WorkPicker />,
  async play({ canvasElement }) {
    await userEvent.type(within(canvasElement).getByRole('combobox', { name: 'Related Work' }), 'zzz');
    await waitFor(() => expect(screen.getByText('No Works found.')).toBeVisible());
  },
};

export const Disabled: Story = {
  render: () => <WorkPicker disabled />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: 'Related Work' })).toBeDisabled();
  },
};

export const CjkSearch: Story = {
  render: () => <WorkPicker defaultValue="Kokoro（こころ）" />,
  async play({ canvasElement }) {
    const input = within(canvasElement).getByRole('combobox', { name: 'Related Work' });
    await expect(input).toHaveValue('Kokoro（こころ）');
    await userEvent.clear(input);
    await userEvent.type(input, '三');
    const listbox = await screen.findByRole('listbox');
    await waitFor(() => expect(within(listbox).getByRole('option', { name: '三體' })).toBeVisible());
  },
};

const Genres = () => {
  const anchor = useComboboxAnchor();
  const [value, setValue] = useState<string[]>(['Hard SF', 'Space opera']);
  return (
    <Combobox
      multiple
      items={['Hard SF', 'Space opera', 'Cyberpunk', '科幻小說（日本語・中文）']}
      value={value}
      onValueChange={setValue}
    >
      <ComboboxChips ref={anchor} className="max-w-sm">
        <ComboboxValue>
          {(selected: string[]) => (
            <>
              {selected.map((genre) => (
                <ComboboxChip key={genre} showRemove={false}>
                  {genre}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput aria-label="Genres" placeholder={selected.length ? '' : 'Add a genre'} />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>No genres found.</ComboboxEmpty>
        <ComboboxList aria-label="Genres">
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};

export const MultipleChips: Story = {
  render: () => <Genres />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Hard SF')).toBeVisible();
    const input = canvas.getByRole('combobox', { name: 'Genres' });
    await userEvent.click(input);
    const listbox = await settled(await screen.findByRole('listbox'));
    await userEvent.click(within(listbox).getByRole('option', { name: 'Cyberpunk' }));
    await expect(await canvas.findByText('Cyberpunk', { selector: '[data-slot="combobox-chip"]' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Backspace}');
    await waitFor(() =>
      expect(canvas.queryByText('Cyberpunk', { selector: '[data-slot="combobox-chip"]' })).toBeNull(),
    );
  },
};
