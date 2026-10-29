import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookOpenIcon, ChevronRightIcon } from 'lucide-react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '@rezics/ui/shadcn/item';
import { withSurface } from '../stories/support.tsx';
import { MetaLine } from './meta-line.tsx';

const meta = {
  title: 'shadcn/Item',
  component: Item,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Item>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Item variant="outline" className="max-w-md">
      <ItemMedia variant="icon">
        <BookOpenIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Hard science fiction</ItemTitle>
        <ItemDescription>12 Works, updated yesterday</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="outline" size="sm">
          Open
        </Button>
      </ItemActions>
    </Item>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('12 Works, updated yesterday')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Open' }));
  },
};

export const Variants: Story = {
  render: () => (
    <ItemGroup className="max-w-md">
      {(['default', 'outline', 'muted'] as const).map((variant) => (
        <Item key={variant} variant={variant} role="listitem">
          <ItemContent>
            <ItemTitle>{variant} variant</ItemTitle>
            <ItemDescription>Shown on the page ground.</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(3);
    for (const variant of ['default', 'outline', 'muted'])
      await expect(canvas.getByText(`${variant} variant`)).toBeVisible();
  },
};

export const AsLink: Story = {
  render: () => (
    <Item variant="outline" className="max-w-md" render={<a href="#shelf" />}>
      <ItemContent>
        <ItemTitle>Open the shelf</ItemTitle>
        <ItemDescription>Opens in the same tab</ItemDescription>
      </ItemContent>
      <ItemActions>
        <ChevronRightIcon className="size-4" aria-hidden="true" />
      </ItemActions>
    </Item>
  ),
  async play({ canvasElement }) {
    const link = within(canvasElement).getByRole('link', { name: /Open the shelf/ });
    await userEvent.tab();
    await expect(link).toHaveFocus();
  },
};

export const GroupWithSeparators: Story = {
  render: () => (
    // The group's default list role allows only list items, so a group with separators is a plain group.
    <ItemGroup role="group" aria-label="Shelf" className="max-w-md">
      <Item size="sm">
        <ItemHeader>Reading now</ItemHeader>
      </Item>
      <ItemSeparator />
      <Item size="sm">
        <ItemContent>
          <ItemTitle>The Three-Body Problem</ItemTitle>
        </ItemContent>
      </Item>
      <ItemSeparator />
      <Item size="xs">
        <ItemContent>
          <ItemTitle>Blindsight</ItemTitle>
        </ItemContent>
        <ItemFooter>Finished in 2025</ItemFooter>
      </Item>
    </ItemGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('separator')).toHaveLength(2);
    await expect(canvas.getByText('Finished in 2025')).toBeVisible();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <ItemGroup className="max-w-xs">
      <Item variant="outline" role="listitem">
        <ItemContent>
          <ItemTitle>三体Ⅲ：死神永生（完整版，含外傳與作者後記）</ItemTitle>
          <ItemDescription>
            <MetaLine items={['劉慈欣', '重慶出版社', '2010年']} />
          </ItemDescription>
        </ItemContent>
      </Item>
      <Item variant="outline" role="listitem">
        <ItemContent>
          <ItemTitle>
            The Absolutely True Diary of a Part-Time Indian, Illustrated Edition with Extended Notes
          </ItemTitle>
          <ItemDescription>
            A very long description that keeps going well past the width of the card so that it wraps.
          </ItemDescription>
        </ItemContent>
      </Item>
    </ItemGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem')).toHaveLength(2);
    await expect(canvas.getByText(/死神永生/)).toBeVisible();
    await expect(canvas.getByText(/Absolutely True Diary/)).toBeVisible();
  },
};
