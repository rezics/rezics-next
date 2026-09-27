import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  BoldIcon,
  ItalicIcon,
  LayoutGridIcon,
  ListIcon,
  StrikethroughIcon,
  TableIcon,
} from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { ToggleGroup, ToggleGroupItem } from './toggle-group.tsx';

const meta = {
  title: 'Rezics UI/Toggle Group',
  component: ToggleGroup,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'A set of related toggles with roving keyboard focus. In REZICS use it for formatting in the review and Realm post editor (several can be on), or, with `multiple={false}`, for a view switch on shelves and search results such as grid, list or table. Every icon-only item needs an `aria-label`.',
      },
    },
  },
  args: { 'aria-label': 'Text formatting', defaultValue: ['bold'] },
  decorators: [
    (Story, { parameters }) => (
      <div>
        <div className="flex min-h-32 flex-col items-start gap-4 bg-background p-6 font-sans text-foreground">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem aria-label="Bold" value="bold">
        <BoldIcon />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Italic" value="italic">
        <ItalicIcon />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label="Strikethrough" value="strike">
        <StrikethroughIcon />
      </ToggleGroupItem>
    </ToggleGroup>
  ),
} satisfies Meta<typeof ToggleGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const bold = canvas.getByRole('button', { name: 'Bold' });
    const italic = canvas.getByRole('button', { name: 'Italic' });
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(italic);
    await expect(italic).toHaveAttribute('aria-pressed', 'true');
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(bold);
    await expect(bold).toHaveAttribute('aria-pressed', 'false');
  },
};

export const Outline: Story = { args: { variant: 'outline' } };

export const Spaced: Story = { args: { variant: 'outline', spacing: 2 } };

export const SingleSelection: Story = {
  args: {
    'aria-label': 'Shelf layout',
    multiple: false,
    defaultValue: ['grid'],
    variant: 'outline',
  },
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem value="grid">
        <LayoutGridIcon />
        Covers
      </ToggleGroupItem>
      <ToggleGroupItem value="list">
        <ListIcon />
        List
      </ToggleGroupItem>
      <ToggleGroupItem value="table">
        <TableIcon />
        Table
      </ToggleGroupItem>
    </ToggleGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: 'List' }));
    await expect(canvas.getByRole('radio', { name: 'List' })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: 'Covers' })).not.toBeChecked();
  },
};

export const Sizes: Story = {
  render: (args) => (
    <>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <ToggleGroup
          {...args}
          aria-label={`Formatting (${size})`}
          key={size}
          size={size}
          variant="outline"
        >
          <ToggleGroupItem aria-label="Bold" value="bold">
            <BoldIcon />
          </ToggleGroupItem>
          <ToggleGroupItem aria-label="Italic" value="italic">
            <ItalicIcon />
          </ToggleGroupItem>
        </ToggleGroup>
      ))}
    </>
  ),
};

export const Vertical: Story = {
  args: { orientation: 'vertical', variant: 'outline' },
};

export const Chinese: Story = {
  args: {
    'aria-label': '书架视图',
    multiple: false,
    defaultValue: ['reading'],
    variant: 'outline',
  },
  render: (args) => (
    <ToggleGroup {...args}>
      <ToggleGroupItem value="want">想读 · 12</ToggleGroupItem>
      <ToggleGroupItem value="reading">在读 · 3</ToggleGroupItem>
      <ToggleGroupItem value="read">读过 · 248</ToggleGroupItem>
    </ToggleGroup>
  ),
};

export const Disabled: Story = {
  args: { disabled: true, variant: 'outline' },
  async play({ canvasElement }) {
    for (const button of within(canvasElement).getAllByRole('button')) {
      await expect(button).toBeDisabled();
    }
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: (args) => (
    <>
      {meta.render(args)}
      <ToggleGroup {...args} variant="outline">
        <ToggleGroupItem aria-label="Bold" value="bold">
          <BoldIcon />
        </ToggleGroupItem>
        <ToggleGroupItem aria-label="Italic" value="italic">
          <ItalicIcon />
        </ToggleGroupItem>
        <ToggleGroupItem aria-label="Strikethrough" disabled value="strike">
          <StrikethroughIcon />
        </ToggleGroupItem>
      </ToggleGroup>
    </>
  ),
};
