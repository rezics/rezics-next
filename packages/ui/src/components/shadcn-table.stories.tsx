import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@rezics/ui/shadcn/table';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Table',
  component: Table,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Table>;
export default meta;
type Story = StoryObj<typeof meta>;

const rows = [
  { title: 'The Three-Body Problem', author: 'Liu Cixin', year: '2008' },
  { title: '三体：黑暗森林与更多的长标题作品名称', author: '刘慈欣', year: '2008' },
  { title: 'Dune', author: 'Frank Herbert', year: '1965' },
];

export const Default: Story = {
  render: () => (
    <Table className="max-w-xl [&_td]:whitespace-normal [&_th]:whitespace-normal">
      <TableCaption>Works on your shelf</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Author</TableHead>
          <TableHead className="text-right">Year</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.title}>
            <TableCell className="font-medium">{row.title}</TableCell>
            <TableCell>{row.author}</TableCell>
            <TableCell className="text-right">{row.year}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell colSpan={2}>Total</TableCell>
          <TableCell className="text-right">{rows.length}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
  async play({ canvasElement }) {
    const table = within(canvasElement).getByRole('table', { name: 'Works on your shelf' });
    await expect(within(table).getAllByRole('columnheader')).toHaveLength(3);
    await expect(within(table).getAllByRole('row')).toHaveLength(5);
    await expect(within(table).getByRole('cell', { name: /黑暗森林/ })).toBeInTheDocument();
  },
};

export const Selected: Story = {
  render: () => (
    <Table className="max-w-xl [&_td]:whitespace-normal [&_th]:whitespace-normal">
      <TableCaption>Selection</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow data-state="selected">
          <TableCell>Dune</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Solaris</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('row', { name: 'Dune' })).toHaveAttribute('data-state', 'selected');
  },
};

export const Empty: Story = {
  render: () => (
    <Table className="max-w-xl [&_td]:whitespace-normal [&_th]:whitespace-normal">
      <TableCaption>空书架</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Author</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell colSpan={2} className="h-24 text-center text-muted-foreground">
            还没有作品。No Works yet.
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('cell', { name: /还没有作品/ })).toHaveAttribute('colspan', '2');
  },
};

export const NarrowWrapping: Story = {
  render: () => (
    <div className="w-72 text-xs">
      <Table className="[&_td]:whitespace-normal [&_th]:whitespace-normal">
        <TableCaption>Long titles wrap inside a narrow column</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Author</TableHead>
            <TableHead>Publisher</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>《三体》第三部：死神永生与更多的长标题作品名称，用来检查窄屏幕滚动</TableCell>
            <TableCell>刘慈欣</TableCell>
            <TableCell>重庆出版社，重庆出版集团有限责任公司</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  ),
  async play({ canvasElement }) {
    const container = canvasElement.querySelector<HTMLElement>('[data-slot="table-container"]')!;
    await expect(within(container).getByRole('table')).toBeInTheDocument();
    await expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
  },
};
