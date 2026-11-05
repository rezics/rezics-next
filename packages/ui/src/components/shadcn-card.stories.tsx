import type { Meta, StoryObj } from '@storybook/react-vite';
import { MoreHorizontalIcon } from 'lucide-react';
import { expect, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@rezics/ui/shadcn/card';
import { withSurface } from '../stories/support.tsx';
import { metaText } from './meta-line.tsx';

const meta = {
  title: 'shadcn/Card',
  component: Card,
  tags: ['autodocs'],
  decorators: [withSurface],
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

const Shelf = ({ title, description, body }: { title: string; description: string; body: string }) => (
  <Card className="max-w-sm">
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
      <CardAction>
        <Button variant="ghost" size="icon" aria-label="Shelf actions">
          <MoreHorizontalIcon />
        </Button>
      </CardAction>
    </CardHeader>
    <CardContent>{body}</CardContent>
    <CardFooter className="gap-2">
      <Button>Open shelf</Button>
      <Button variant="outline">Share</Button>
    </CardFooter>
  </Card>
);

export const Default: Story = {
  render: () => (
    <Shelf
      title="Hard science fiction"
      description={metaText(['24 Works', 'updated yesterday'])}
      body="Books I want to finish this year."
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Hard science fiction')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Open shelf' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Shelf actions' })).toBeVisible();
  },
};

export const Small: Story = {
  render: () => (
    <Card size="sm" className="max-w-xs">
      <CardHeader>
        <CardTitle>Reading goal</CardTitle>
        <CardDescription>You are 3 books ahead of schedule.</CardDescription>
      </CardHeader>
    </Card>
  ),
  async play({ canvasElement }) {
    const card = canvasElement.querySelector('[data-slot="card"]')!;
    await expect(card).toHaveAttribute('data-size', 'sm');
    await expect(within(canvasElement).getByText('Reading goal')).toBeVisible();
  },
};

export const LongAndCjkText: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <Shelf
        title="Hard science fiction and space opera that I intend to finish before the end of the year"
        description="A shelf title this long wraps instead of pushing the actions out of the card"
        body="Ken Liu’s translation of The Three-Body Problem, followed by Dune, Hyperion and A Fire Upon the Deep."
      />
      <Shelf
        title="硬科幻與太空歌劇書架"
        description="共 24 部作品・昨天更新"
        body="今年想讀完的書。日本語の本も含みます。"
      />
    </div>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('硬科幻與太空歌劇書架')).toBeVisible();
    for (const button of canvas.getAllByRole('button', { name: 'Shelf actions' })) await expect(button).toBeVisible();
  },
};
