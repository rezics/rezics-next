import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { ButtonGroup, ButtonGroupSeparator, ButtonGroupText } from '@rezics/ui/shadcn/button-group';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/ButtonGroup',
  component: ButtonGroup,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof ButtonGroup>;
export default meta;
type Story = StoryObj<typeof meta>;

const Pager = () => {
  const [page, setPage] = useState(2);
  return (
    <ButtonGroup aria-label="Pagination">
      <Button
        variant="outline"
        size="icon"
        aria-label="Previous page"
        disabled={page === 1}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeftIcon />
      </Button>
      <ButtonGroupText aria-live="polite">Page {page} of 3</ButtonGroupText>
      <Button
        variant="outline"
        size="icon"
        aria-label="Next page"
        disabled={page === 3}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRightIcon />
      </Button>
    </ButtonGroup>
  );
};

export const Default: Story = {
  render: () => <Pager />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('group', { name: 'Pagination' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Next page' }));
    await expect(await canvas.findByText('Page 3 of 3')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Next page' })).toBeDisabled();
  },
};

export const Vertical: Story = {
  render: () => (
    <ButtonGroup orientation="vertical" aria-label="Shelf actions">
      <Button variant="outline">Rename</Button>
      <Button variant="outline">Share</Button>
      <Button variant="outline" disabled>
        Archive
      </Button>
    </ButtonGroup>
  ),
  async play({ canvasElement }) {
    const group = within(canvasElement).getByRole('group', { name: 'Shelf actions' });
    await expect(group).toHaveAttribute('data-orientation', 'vertical');
    await expect(within(group).getByRole('button', { name: 'Archive' })).toBeDisabled();
  },
};

export const WithSeparator: Story = {
  render: () => (
    <ButtonGroup aria-label="Reading status">
      <Button variant="secondary">Want to read</Button>
      <ButtonGroupSeparator />
      <Button variant="secondary">Reading</Button>
      <ButtonGroupSeparator />
      <Button variant="secondary">Finished</Button>
    </ButtonGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Want to read' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Reading' })).toHaveFocus();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <ButtonGroup aria-label="Edition" className="max-w-full flex-wrap">
      <ButtonGroupText>版本</ButtonGroupText>
      <Button variant="outline">三體：地球往事（精裝版）</Button>
      <Button variant="outline">The Three-Body Problem, anniversary hardcover</Button>
    </ButtonGroup>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: '三體：地球往事（精裝版）' })).toBeVisible();
    await expect(canvas.getByText('版本')).toBeVisible();
  },
};
