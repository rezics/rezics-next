import type { Meta, StoryObj } from '@storybook/react-vite';
import { InfoIcon } from 'lucide-react';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withTheme } from '../stories/support.tsx';
import { Button } from './button.tsx';
import {
  Popover,
  PopoverArrow,
  PopoverBody,
  PopoverClose,
  PopoverContent,
  PopoverFooter,
  PopoverHeader,
  PopoverTrigger,
} from './popover.tsx';

const meta = {
  title: 'Rezics UI/Popover',
  component: Popover,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    docs: {
      description: {
        component:
          'A floating panel anchored to its trigger for short, interactive content that keeps the page in view: explaining a rating’s Context, choosing which Realm to cross-post to, quick shelf notes. It is modal by default (focus stays inside until it closes); pass `modal={false}` for purely informational panels. Use a tooltip for a one-line label and a dialog when the task needs the reader’s full attention.',
      },
      story: { inline: false, iframeHeight: 420 },
    },
  },
} satisfies Meta<typeof Popover>;
export default meta;
type Story = StoryObj<typeof meta>;

const RatingContext = (props: React.ComponentProps<typeof Popover>) => (
  <Popover {...props}>
    <PopoverTrigger asChild>
      <Button variant="outline">
        <InfoIcon aria-hidden />
        4.3 · Hard SF readers
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-80" showCloseButton>
      <PopoverHeader
        description="Ratings on REZICS always carry a Context: who rated, and against what."
        title="About this rating"
      />
      <PopoverBody className="text-sm">
        4.3 out of 5 from 1,284 members of the Hard SF Realm who marked an edition as read. The
        publisher’s own aggregate is shown separately as a source statistic.
      </PopoverBody>
      <PopoverFooter>
        <PopoverClose asChild>
          <Button size="sm" variant="outline">
            Close
          </Button>
        </PopoverClose>
        <Button size="sm">See distribution</Button>
      </PopoverFooter>
    </PopoverContent>
  </Popover>
);

const openPopover = async (canvasElement: HTMLElement, name: RegExp | string) => {
  await userEvent.click(within(canvasElement).getByRole('button', { name }));
  return settled(await screen.findByRole('dialog'));
};

export const Default: Story = {
  render: (args) => <RatingContext {...args} />,
  async play({ canvasElement }) {
    const popover = await openPopover(canvasElement, /Hard SF readers/);
    await expect(within(popover).getByText('About this rating')).toBeVisible();
  },
};

export const CloseWithEscape: Story = {
  render: (args) => <RatingContext {...args} />,
  async play({ canvasElement }) {
    await openPopover(canvasElement, /Hard SF readers/);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(
      within(canvasElement).getByRole('button', { name: /Hard SF readers/ }),
    ).toHaveFocus();
  },
};

export const CloseWithButton: Story = {
  render: (args) => <RatingContext {...args} />,
  async play({ canvasElement }) {
    const popover = await openPopover(canvasElement, /Hard SF readers/);
    await userEvent.click(within(popover).getAllByRole('button', { name: 'Close' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  },
};

export const WithArrow: Story = {
  render: (args) => (
    <div className="flex justify-center pt-64">
      <Popover positioning={{ placement: 'top' }} {...args}>
        <PopoverTrigger asChild>
          <Button variant="outline">Cross-post</Button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <PopoverArrow />
          <PopoverHeader
            description="The post keeps one discussion thread; each Realm links to it."
            title="Also share to"
          />
          <PopoverBody className="flex flex-col gap-1 text-sm">
            <span>Hard SF · 18.2k members</span>
            <span>Translated Fiction · 6.4k members</span>
          </PopoverBody>
        </PopoverContent>
      </Popover>
    </div>
  ),
  async play({ canvasElement }) {
    const popover = await openPopover(canvasElement, 'Cross-post');
    await expect(popover).toHaveAccessibleName('Also share to');
    await waitFor(() => expect(popover).toHaveAttribute('data-placement', 'top'));
  },
};

const outsideClick = fn();

/**
 * Leaves the page usable: no focus trap, no inert page, and an outside click dismisses it
 * (checked in a real browser; synthetic outside clicks race Zag's listener under load).
 */
export const NonModal: Story = {
  render: (args) => (
    <div className="flex min-h-96 flex-col justify-between">
      <RatingContext {...args} modal={false} />
      <Button className="w-fit" onClick={outsideClick} size="sm" variant="ghost">
        1,284 ratings · updated hourly
      </Button>
    </div>
  ),
  async play({ canvasElement }) {
    const popover = await openPopover(canvasElement, /Hard SF readers/);
    await expect(popover).not.toHaveAttribute('aria-modal', 'true');
    await expect(document.body).not.toHaveAttribute('data-inert');
    await userEvent.click(within(canvasElement).getByRole('button', { name: /updated hourly/ }));
    await expect(outsideClick).toHaveBeenCalled();
  },
};

export const LongContent: Story = {
  render: (args) => (
    <Popover {...args}>
      <PopoverTrigger asChild>
        <Button variant="outline">Edition notes</Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-72 w-80">
        <PopoverHeader title="Edition notes" />
        <PopoverBody className="flex flex-col gap-3 text-sm">
          <p>
            The 2014 Tor edition follows Ken Liu’s translation, which restores the Cultural
            Revolution opening that the 2006 serialisation moved to the middle of the book.
          </p>
          <p>
            Chapter numbering differs from the 2008 Chongqing Publishing Group edition by three
            chapters after “Red Coast”. Reading groups in the Translated Fiction Realm cite the
            English numbering and give the Chinese chapter in brackets.
          </p>
          <p>
            A 2023 revised printing corrects the orbital diagram in chapter 17. Ratings are not
            split by printing; report errata as a revision to the edition instead.
          </p>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  ),
  async play({ canvasElement }) {
    const popover = await openPopover(canvasElement, 'Edition notes');
    await expect(within(popover).getByText(/orbital diagram/)).toBeInTheDocument();
  },
};

export const Chinese: Story = {
  render: (args) => (
    <Popover {...args}>
      <PopoverTrigger asChild>
        <Button variant="outline">评分说明</Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" showCloseButton>
        <PopoverHeader
          description="REZICS 的评分总带有语境：谁评的，以什么为标准。"
          title="关于《三体》的评分"
        />
        <PopoverBody className="text-sm">
          4.6 分来自「科幻」Realm 中 3,902
          位已标记读过的成员。出版方的汇总评分作为来源统计单独显示。
        </PopoverBody>
      </PopoverContent>
    </Popover>
  ),
  async play({ canvasElement }) {
    const popover = await openPopover(canvasElement, '评分说明');
    await expect(within(popover).getByText('关于《三体》的评分')).toBeVisible();
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark' },
};
