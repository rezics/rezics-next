import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withTheme } from '../stories/support.tsx';
import { Avatar, AvatarFallback } from './avatar.tsx';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './hover-card.tsx';

const meta = {
  title: 'Rezics UI/Hover Card',
  component: HoverCard,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    docs: {
      description: {
        component:
          'A preview that appears while a pointer rests on, or keyboard focus reaches, a link: a member’s profile behind an @mention, a Work behind a title in a post, a Realm behind its name. It only previews what the link already leads to, so never put the only copy of an action or fact inside it; touch readers never see it.',
      },
      story: { inline: false, iframeHeight: 360 },
    },
  },
} satisfies Meta<typeof HoverCard>;
export default meta;
type Story = StoryObj<typeof meta>;

const MemberPreview = (props: React.ComponentProps<typeof HoverCard>) => (
  <p className="max-w-md pt-40 text-sm">
    Great point from{' '}
    <HoverCard {...props}>
      <HoverCardTrigger asChild>
        <a className="font-medium text-primary underline-offset-4 hover:underline" href="#member">
          @ye_wenjie
        </a>
      </HoverCardTrigger>
      <HoverCardContent className="w-72">
        <div className="flex gap-3">
          <Avatar size="lg">
            <AvatarFallback>YW</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-semibold">Ye Wenjie</p>
            <p className="text-muted-foreground text-xs">Moderator · Hard SF · joined 2024</p>
            <p className="text-sm">Reads first-contact fiction and astrophysics popularisations.</p>
            <p className="text-muted-foreground text-xs">412 ratings · 38 reviews · 9 shelves</p>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>{' '}
    on the Red Coast chapter.
  </p>
);

const hoverMention = async (canvasElement: HTMLElement, name: string) => {
  await userEvent.hover(within(canvasElement).getByRole('link', { name }));
  return settled(await screen.findByText(/412 ratings/));
};

export const Default: Story = {
  render: (args) => <MemberPreview {...args} />,
  async play({ canvasElement }) {
    await expect(await hoverMention(canvasElement, '@ye_wenjie')).toBeVisible();
  },
};

export const CloseOnLeave: Story = {
  render: (args) => <MemberPreview {...args} />,
  async play({ canvasElement }) {
    await hoverMention(canvasElement, '@ye_wenjie');
    await userEvent.unhover(within(canvasElement).getByRole('link', { name: '@ye_wenjie' }));
    await waitFor(() => expect(screen.queryByText(/412 ratings/)).not.toBeInTheDocument());
  },
};

export const OpenOnFocus: Story = {
  render: (args) => <MemberPreview {...args} />,
  async play({ canvasElement }) {
    await userEvent.tab();
    await expect(within(canvasElement).getByRole('link', { name: '@ye_wenjie' })).toHaveFocus();
    await expect(await screen.findByText(/412 ratings/)).toBeInTheDocument();
  },
};

export const Bottom: Story = {
  render: (args) => <MemberPreview {...args} positioning={{ placement: 'bottom-start' }} />,
  play: Default.play,
};

export const Chinese: Story = {
  render: (args) => (
    <p className="max-w-md pt-40 text-sm">
      推荐先读{' '}
      <HoverCard {...args}>
        <HoverCardTrigger asChild>
          <a className="font-medium text-primary underline-offset-4 hover:underline" href="#work">
            《三体》
          </a>
        </HoverCardTrigger>
        <HoverCardContent className="w-72">
          <p className="font-heading font-semibold text-base">三体 (The Three-Body Problem)</p>
          <p className="text-muted-foreground text-xs">刘慈欣 · 2006 · 地球往事三部曲 第一部</p>
          <p className="mt-2 text-sm">「科幻」Realm 评分 4.6 · 3,902 位读者</p>
        </HoverCardContent>
      </HoverCard>
      ，再读续作。
    </p>
  ),
  async play({ canvasElement }) {
    await userEvent.hover(within(canvasElement).getByRole('link', { name: '《三体》' }));
    await expect(await settled(await screen.findByText(/3,902 位读者/))).toBeVisible();
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark' },
};
