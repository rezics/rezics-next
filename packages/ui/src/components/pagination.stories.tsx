import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { withTheme } from '../stories/support.tsx';
import { Pagination, PaginationItems, PaginationNext, PaginationPrevious } from './pagination.tsx';

const meta = {
  title: 'Rezics UI/Pagination',
  component: Pagination,
  tags: ['autodocs'],
  decorators: [withTheme],
  args: { count: 1284, pageSize: 20, defaultPage: 1, onPageChange: fn() },
} satisfies Meta<typeof Pagination>;
export default meta;
type Story = StoryObj<typeof meta>;

const Reviews = (args: React.ComponentProps<typeof Pagination>) => (
  <Pagination {...args}>
    <PaginationPrevious />
    <PaginationItems />
    <PaginationNext />
  </Pagination>
);

export const FirstPage: Story = {
  render: (args) => <Reviews {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: /previous/i })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: /page 1/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(canvas.getByRole('button', { name: /last page, page 65/i })).toBeVisible();
  },
};

export const GoToNext: Story = {
  render: (args) => <Reviews {...args} />,
  async play({ args, canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /next/i }));
    await expect(args.onPageChange).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
    await expect(canvas.getByRole('button', { name: /page 2/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

export const MiddlePage: Story = {
  args: { defaultPage: 32 },
  render: (args) => <Reviews {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /page 33/i }));
    await expect(canvas.getByRole('button', { name: /page 33/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

export const LastPage: Story = {
  args: { defaultPage: 65 },
  render: (args) => <Reviews {...args} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: /next/i })).toBeDisabled();
  },
};

export const FewPages: Story = {
  args: { count: 54, defaultPage: 2 },
  render: (args) => <Reviews {...args} />,
};

export const Links: Story = {
  args: { type: 'link', getPageUrl: ({ page }) => `?page=${page}` },
  render: (args) => <Reviews {...args} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: /page 2/i })).toHaveAttribute(
      'href',
      '?page=2',
    );
  },
};

export const Chinese: Story = {
  args: { defaultPage: 3 },
  render: (args) => (
    <Pagination
      {...args}
      translations={{
        rootLabel: '书评分页',
        prevTriggerLabel: '上一页',
        nextTriggerLabel: '下一页',
        itemLabel: ({ page, totalPages }) =>
          page === totalPages ? `最后一页，第 ${page} 页` : `第 ${page} 页`,
      }}
    >
      <PaginationPrevious>上一页</PaginationPrevious>
      <PaginationItems />
      <PaginationNext>下一页</PaginationNext>
    </Pagination>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: '书评分页' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: '下一页' }));
    await expect(canvas.getByRole('button', { name: '第 4 页' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

export const Dark: Story = {
  ...MiddlePage,
  parameters: { theme: 'dark' },
};
