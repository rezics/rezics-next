import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { StarIcon } from 'lucide-react';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Badge } from './badge.tsx';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from './table.tsx';

const surface: Decorator = (Story, { parameters }) => (
  <div className={cn('max-w-3xl bg-background p-6 font-sans text-foreground')}>
    <Story />
  </div>
);

interface ShelfRow {
  author: string;
  id: string;
  rating: number;
  status: 'Read' | 'Reading' | 'Want to read';
  title: string;
  year: number;
}

const shelf: ShelfRow[] = [
  {
    id: 'w1',
    title: 'The Dispossessed',
    author: 'Ursula K. Le Guin',
    year: 1974,
    rating: 5,
    status: 'Read',
  },
  {
    id: 'w2',
    title: 'The Three-Body Problem',
    author: 'Liu Cixin',
    year: 2008,
    rating: 4,
    status: 'Read',
  },
  {
    id: 'w3',
    title: 'Piranesi',
    author: 'Susanna Clarke',
    year: 2020,
    rating: 5,
    status: 'Reading',
  },
  {
    id: 'w4',
    title: 'A Memory Called Empire',
    author: 'Arkady Martine',
    year: 2019,
    rating: 0,
    status: 'Want to read',
  },
];

const statusVariant = { Read: 'secondary', Reading: 'default', 'Want to read': 'outline' } as const;

const Rating = ({ value }: { value: number }) =>
  value === 0 ? (
    <span className="text-muted-foreground">Not rated</span>
  ) : (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <StarIcon aria-hidden className="size-4 fill-rating text-rating" />
      {value}.0
    </span>
  );

const ShelfTable = (props: React.ComponentProps<typeof Table> & { rows?: ShelfRow[] }) => {
  const { rows = shelf, ...rest } = props;

  return (
    <Table {...rest}>
      <TableCaption>Liu Yang's "Favorites" shelf</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Author</TableHead>
          <TableHead className="text-right">Year</TableHead>
          <TableHead>Your rating</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell className="h-24 text-center text-muted-foreground" colSpan={5}>
              This shelf is empty. Add Works from any Work page.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-heading font-medium">{row.title}</TableCell>
              <TableCell>{row.author}</TableCell>
              <TableCell className="text-right tabular-nums">{row.year}</TableCell>
              <TableCell>
                <Rating value={row.rating} />
              </TableCell>
              <TableCell>
                <Badge variant={statusVariant[row.status]}>{row.status}</Badge>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
};

const meta = {
  title: 'Rezics UI/Layout/Table',
  component: Table,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A semantic data table for comparing rows across columns: a member\'s shelf, edition lists of a Work, moderation queues or provider statistics. It sits in its own bordered, horizontally scrollable container with a tinted header. Always give it a `TableCaption` or an `aria-label`; use `variant="striped"` for long numeric tables and set `isHoverable={false}` when rows are not interactive. Use Data List for the properties of a single record.',
      },
    },
  },
} satisfies Meta<typeof Table>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => <ShelfTable {...args} />,
  async play({ canvasElement }) {
    const table = within(canvasElement).getByRole('table', { name: /Favorites/ });
    await expect(within(table).getAllByRole('row')).toHaveLength(5);
    await expect(within(table).getAllByRole('columnheader')).toHaveLength(5);
  },
};

export const Striped: Story = {
  args: { variant: 'striped', isHoverable: false },
  render: (args) => <ShelfTable {...args} />,
};

export const WithFooter: Story = {
  render: () => (
    <Table>
      <TableCaption>Rating distribution for The Dispossessed in Hard Science Fiction</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Stars</TableHead>
          <TableHead className="text-right">Ratings</TableHead>
          <TableHead className="text-right">Share</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[
          [5, 1204, '52%'],
          [4, 736, '32%'],
          [3, 231, '10%'],
          [2, 92, '4%'],
          [1, 46, '2%'],
        ].map(([stars, count, share]) => (
          <TableRow key={stars}>
            <TableCell>{stars} stars</TableCell>
            <TableCell className="text-right tabular-nums">{count.toLocaleString('en')}</TableCell>
            <TableCell className="text-right tabular-nums">{share}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>Total</TableCell>
          <TableCell className="text-right tabular-nums">2,309</TableCell>
          <TableCell className="text-right tabular-nums">100%</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

const SelectableTable = () => {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  return (
    <Table aria-label="Reported reviews">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <span className="sr-only">Select</span>
          </TableHead>
          <TableHead>Review</TableHead>
          <TableHead>Reports</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[
          ['r1', "Spoilers for the ending of Death's End", 4],
          ['r2', 'Off-topic promotion of another Realm', 2],
          ['r3', 'Harassment of the reviewer', 7],
        ].map(([id, summary, reports]) => {
          const isSelected = selected.includes(id as string);
          return (
            <TableRow data-state={isSelected ? 'selected' : undefined} key={id}>
              <TableCell>
                <input
                  aria-label={`Select "${summary}"`}
                  checked={isSelected}
                  className="size-4 accent-primary"
                  onChange={() => toggle(id as string)}
                  type="checkbox"
                />
              </TableCell>
              <TableCell>{summary}</TableCell>
              <TableCell className="tabular-nums">{reports}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
};

export const SelectableRows: Story = {
  render: () => <SelectableTable />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole('checkbox', { name: /Harassment/ });
    await userEvent.click(checkbox);
    await expect(checkbox.closest('tr')).toHaveAttribute('data-state', 'selected');
    await userEvent.keyboard(' ');
    await expect(checkbox.closest('tr')).not.toHaveAttribute('data-state');
  },
};

export const Empty: Story = {
  render: () => <ShelfTable rows={[]} />,
};

export const LongContent: Story = {
  name: 'Long content (zh-CN and mixed)',
  render: () => (
    <div className="max-w-md" lang="zh-CN">
      <ShelfTable
        rows={[
          {
            id: 'z1',
            title: '三体 II：黑暗森林',
            author: '刘慈欣',
            year: 2008,
            rating: 5,
            status: 'Read',
          },
          {
            id: 'z2',
            title: 'The Three-Body Problem 三体（英文版，Ken Liu 译，Tor Books 2014 年精装首版）',
            author: 'Liu Cixin 刘慈欣 · translated by Ken Liu',
            year: 2014,
            rating: 4,
            status: 'Reading',
          },
          {
            id: 'z3',
            title: '球状闪电',
            author: '刘慈欣',
            year: 2004,
            rating: 0,
            status: 'Want to read',
          },
        ]}
      />
    </div>
  ),
  async play({ canvasElement }) {
    const wrapper = canvasElement.querySelector('[data-slot="table-wrapper"]');
    await waitFor(() => expect(wrapper).toHaveAttribute('tabindex', '0'));
  },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
  render: () => <ShelfTable variant="striped" />,
};
