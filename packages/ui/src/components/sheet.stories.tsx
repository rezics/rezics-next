import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import { dismissed, settled, withSurface } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTrigger,
} from './sheet.tsx';

const meta = {
  title: 'Rezics UI/Sheet',
  component: Sheet,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 560 },
    },
  },
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

type Placement = 'left' | 'right' | 'top' | 'bottom';

const revisions = [
  ['Rev 42', 'Added the 2014 English translation by Ken Liu', '2 hours ago'],
  ['Rev 41', 'Corrected original publication year to 2006', 'yesterday'],
  ['Rev 40', 'Linked the Remembrance of Earth’s Past series', '3 days ago'],
  ['Rev 39', 'Merged duplicate Work “Three Body Problem”', 'last week'],
];

const RevisionSheet = (props: { placement?: Placement; variant?: 'default' | 'inset' }) => (
  <Sheet>
    <SheetTrigger asChild>
      <Button variant="outline">Revision history</Button>
    </SheetTrigger>
    <SheetContent placement={props.placement} variant={props.variant}>
      <SheetHeader
        description="Every published change to this Work, newest first."
        title="The Three-Body Problem"
      />
      <SheetBody>
        <ol className="flex flex-col gap-4 text-sm">
          {revisions.map(([id, text, when]) => (
            <li className="flex flex-col gap-0.5" key={id}>
              <span className="font-mono text-muted-foreground text-xs">
                {id} · {when}
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="outline">Close</Button>
        </SheetClose>
        <Button>Compare revisions</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
);

const openSheet = async (canvasElement: HTMLElement, name = 'Revision history') => {
  await userEvent.click(within(canvasElement).getByRole('button', { name }));
  return settled(await screen.findByRole('dialog'));
};

export const Right: Story = {
  render: () => <RevisionSheet />,
  async play({ canvasElement }) {
    const sheet = await openSheet(canvasElement);
    await expect(within(sheet).getByText('Rev 42 · 2 hours ago')).toBeVisible();
    await expect(within(sheet).getAllByRole('button', { name: 'Close' })[0]).toHaveFocus();
  },
};

export const Left: Story = {
  render: () => <RevisionSheet placement="left" />,
  play: Right.play,
};

export const Bottom: Story = {
  render: () => <RevisionSheet placement="bottom" />,
  play: Right.play,
};

export const Top: Story = {
  render: () => <RevisionSheet placement="top" />,
  play: Right.play,
};

export const Inset: Story = {
  render: () => <RevisionSheet variant="inset" />,
  play: Right.play,
};

export const CloseWithEscape: Story = {
  render: () => <RevisionSheet />,
  async play({ canvasElement }) {
    await openSheet(canvasElement);
    await userEvent.keyboard('{Escape}');
    await dismissed('dialog');
    await expect(
      within(canvasElement).getByRole('button', { name: 'Revision history' }),
    ).toHaveFocus();
  },
};

export const LongContent: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open report queue</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader description="Hard SF · 24 open reports" title="Report queue" />
        <SheetBody scrollFade>
          <ul className="flex flex-col gap-3 text-sm">
            {Array.from({ length: 24 }, (_, index) => (
              <li key={index}>
                <a
                  className="flex flex-col rounded-2xl border border-border/60 bg-card p-3 outline-none hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/32"
                  href={`#report-${1200 + index}`}
                >
                  <span className="font-medium">
                    Report #{1200 + index}:{' '}
                    {index % 2 ? 'Untagged spoiler' : 'Off-topic self-promotion'}
                  </span>
                  <span className="text-muted-foreground">
                    On “Is the dark forest hypothesis still convincing in 2026?” · reported by 3
                    readers
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </SheetBody>
      </SheetContent>
    </Sheet>
  ),
  async play({ canvasElement }) {
    const sheet = await openSheet(canvasElement, 'Open report queue');
    await expect(within(sheet).getByText('Report #1223: Untagged spoiler')).toBeInTheDocument();
  },
};

export const Chinese: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">筛选</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader description="只显示符合条件的帖子。" title="筛选「科幻」Realm 的帖子" />
        <SheetBody>
          <p className="text-sm">
            当前条件：讨论《三体》（The Three-Body Problem）· 最近 30 天 · 至少 10 个赞同。
          </p>
        </SheetBody>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="outline">重置</Button>
          </SheetClose>
          <Button>应用筛选</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
  async play({ canvasElement }) {
    const sheet = await openSheet(canvasElement, '筛选');
    await expect(
      within(sheet).getByRole('heading', { name: '筛选「科幻」Realm 的帖子' }),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  ...Right,
  globals: { theme: 'dark' },
};
