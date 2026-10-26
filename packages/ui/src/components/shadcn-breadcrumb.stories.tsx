import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@rezics/ui/shadcn/breadcrumb';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Breadcrumb',
  component: Breadcrumb,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Breadcrumb>;
export default meta;
type Story = StoryObj<typeof meta>;

const Trail = ({ trail, collapsed }: { trail: string[]; collapsed?: boolean }) => (
  <Breadcrumb className="max-w-md">
    <BreadcrumbList>
      {trail.slice(0, -1).map((label, index) => (
        <BreadcrumbItem key={label}>
          {collapsed && index === 1 ? (
            <BreadcrumbEllipsis />
          ) : (
            <BreadcrumbLink href={`#${index}`}>{label}</BreadcrumbLink>
          )}
          <BreadcrumbSeparator />
        </BreadcrumbItem>
      ))}
      <BreadcrumbItem>
        <BreadcrumbPage>{trail.at(-1)}</BreadcrumbPage>
      </BreadcrumbItem>
    </BreadcrumbList>
  </Breadcrumb>
);

export const Default: Story = {
  render: () => <Trail trail={['Library', 'Fiction', 'Dune']} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: 'breadcrumb' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '#0');
    await expect(canvas.getByRole('link', { name: 'Dune' })).toHaveAttribute('aria-current', 'page');
  },
};

export const Collapsed: Story = {
  render: () => <Trail collapsed trail={['Library', 'Fiction', 'Science fiction', 'Dune']} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('listitem').length).toBeGreaterThan(0);
    await expect(canvas.getByRole('link', { name: 'Library' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Fiction' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Dune' })).toHaveAttribute('aria-current', 'page');
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <Trail
      trail={['書庫', 'Hard science fiction and space opera from the nineteen-sixties', '三體：地球往事（第一部）']}
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: '書庫' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: '三體：地球往事（第一部）' })).toBeVisible();
  },
};
