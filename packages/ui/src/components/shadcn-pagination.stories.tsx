import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@rezics/ui/shadcn/pagination';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Pagination',
  component: Pagination,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Pagination>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#page-1" />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-1">1</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-2" isActive>
            2
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-3">3</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationEllipsis />
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#page-3" />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  ),
  async play({ canvasElement }) {
    const nav = within(canvasElement).getByRole('navigation', { name: 'pagination' });
    await expect(within(nav).getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page');
    await expect(within(nav).getByRole('button', { name: '1' })).not.toHaveAttribute('aria-current');
    await expect(within(nav).getByRole('button', { name: 'Go to next page' })).toHaveAttribute('href', '#page-3');
  },
};

export const CJKLabels: Story = {
  render: () => (
    <Pagination aria-label="分页">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#page-1" text="上一页" aria-label="上一页" />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-2" isActive>
            第 2 页
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#page-3" text="下一页" aria-label="下一页" />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  ),
  async play({ canvasElement }) {
    const nav = within(canvasElement).getByRole('navigation', { name: '分页' });
    await expect(within(nav).getByRole('button', { name: '第 2 页' })).toHaveAttribute('aria-current', 'page');
    await expect(within(nav).getAllByRole('button')).toHaveLength(3);
  },
};

export const FirstPage: Story = {
  render: () => (
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious aria-disabled="true" tabIndex={-1} className="pointer-events-none opacity-50" />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-1" isActive>
            1
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#page-2">2</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#page-2" />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByLabelText('Go to previous page')).toHaveAttribute('aria-disabled', 'true');
  },
};
