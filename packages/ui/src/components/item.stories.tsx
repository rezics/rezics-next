import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { BookOpenIcon, ChevronRightIcon, ShieldCheckIcon, UsersIcon } from 'lucide-react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { cn } from '../utils.ts';
import { Avatar, AvatarFallback } from './avatar.tsx';
import { Button } from './button.tsx';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemHeader,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from './item.tsx';

// Renders on the theme page color; `parameters.dark` switches to dark mode
// until Storybook has a global theme toolbar.
const surface: Decorator = (Story, { parameters }) => (
  <div
    className={cn(
      parameters.dark && 'dark',
      'max-w-xl bg-background p-6 font-sans text-foreground',
    )}
  >
    <Story />
  </div>
);

// Inline cover so stories never depend on the network.
const cover = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 60"><rect width="40" height="60" fill="#1f4a85"/><circle cx="20" cy="24" r="9" fill="#bf7a0e"/><rect x="6" y="44" width="28" height="3" fill="#e4ecf7"/></svg>',
)}`;

const meta = {
  title: 'Rezics UI/Layout/Item',
  component: Item,
  tags: ['autodocs'],
  decorators: [surface],
  parameters: {
    docs: {
      description: {
        component:
          'A row of media, title, description and actions: a Realm in a directory, a Work on a shelf, a member in a list or a setting with a toggle. `outline` is an Aura card with the card shadow, `muted` a quiet secondary surface, `default` has no chrome. Inside an `ItemGroup` items become list items; render an Item `asChild` with `<a>` outside a group when the whole row is a link, or use Link Overlay to keep inner links working.',
      },
    },
  },
} satisfies Meta<typeof Item>;
export default meta;
type Story = StoryObj<typeof meta>;

const onJoin = fn();

export const Default: Story = {
  args: { variant: 'outline' },
  render: (args) => (
    <Item {...args}>
      <ItemMedia variant="icon">
        <UsersIcon aria-hidden />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Hard Science Fiction</ItemTitle>
        <ItemDescription>
          Physics-first stories, from Clarke to Liu Cixin. 12,480 members.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button onClick={onJoin} size="sm" variant="outline">
          Join
        </Button>
      </ItemActions>
    </Item>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Join' }));
    await expect(onJoin).toHaveBeenCalledOnce();
  },
};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(['default', 'outline', 'muted'] as const).map((variant) => (
        <Item key={variant} variant={variant}>
          <ItemContent>
            <ItemTitle>{variant}</ItemTitle>
            <ItemDescription>Reading positions sync across your devices.</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </div>
  ),
};

export const WithCover: Story = {
  render: () => (
    <Item variant="outline">
      <ItemMedia className="h-15" variant="image">
        <img alt="" src={cover} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="font-heading text-base">The Dispossessed</ItemTitle>
        <ItemDescription>Ursula K. Le Guin · 1974 · Read in March</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" variant="ghost">
          Rate
        </Button>
      </ItemActions>
    </Item>
  ),
};

export const AsLink: Story = {
  render: () => (
    <Item asChild variant="outline">
      <a href="#realm">
        <ItemMedia variant="icon">
          <BookOpenIcon aria-hidden />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Continue reading Piranesi</ItemTitle>
          <ItemDescription>Part 5 · 64% through</ItemDescription>
        </ItemContent>
        <ItemActions>
          <ChevronRightIcon aria-hidden />
        </ItemActions>
      </a>
    </Item>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: /Continue reading Piranesi/ })).toHaveFocus();
  },
};

export const Group: Story = {
  render: () => (
    <ItemGroup aria-label="Realm moderators">
      {[
        ['LY', 'Liu Yang', 'Lead moderator since 2024'],
        ['MO', 'Mara Okafor', 'Handles spoiler reports'],
        ['KA', 'Kenji Arai', 'On leave until October'],
      ].map(([initials, name, role], index) => (
        <div className="contents" key={name}>
          {index > 0 && <ItemSeparator />}
          <Item>
            <ItemMedia>
              <Avatar>
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{name}</ItemTitle>
              <ItemDescription>{role}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <ShieldCheckIcon aria-hidden className="text-primary" />
            </ItemActions>
          </Item>
        </div>
      ))}
    </ItemGroup>
  ),
  async play({ canvasElement }) {
    const list = within(canvasElement).getByRole('list', { name: 'Realm moderators' });
    await expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  },
};

export const HeaderAndFooter: Story = {
  render: () => (
    <Item variant="outline">
      <ItemHeader>
        <span className="text-muted-foreground text-xs">Moderation case MOD-2026-0413</span>
      </ItemHeader>
      <ItemContent>
        <ItemTitle>Spoilers in a review of Death's End</ItemTitle>
        <ItemDescription>
          Four members reported the review. It reveals the ending without a spoiler mark.
        </ItemDescription>
      </ItemContent>
      <ItemFooter>
        <span className="text-muted-foreground text-xs">Opened 2 hours ago</span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost">
            Dismiss
          </Button>
          <Button size="sm">Hide review</Button>
        </div>
      </ItemFooter>
    </Item>
  ),
};

export const LongContent: Story = {
  name: 'Long content (zh-CN and mixed)',
  render: () => (
    <Item lang="zh-CN" variant="outline">
      <ItemMedia className="h-15" variant="image">
        <img alt="" src={cover} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="font-heading text-base">
          《三体》The Three-Body Problem（地球往事三部曲之一，重庆出版社 2008 年首版）
        </ItemTitle>
        <ItemDescription>
          刘慈欣 ·
          文化大革命如火如荼进行的同时，军方探寻外星文明的绝秘计划「红岸工程」取得了突破性进展。Translated
          by Ken Liu, winner of the 2015 Hugo Award for Best Novel.
        </ItemDescription>
      </ItemContent>
    </Item>
  ),
};

export const Dark: Story = {
  parameters: { dark: true },
  render: () => (
    <div className="flex flex-col gap-4">
      <Item variant="outline">
        <ItemMedia variant="icon">
          <UsersIcon aria-hidden />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Hard Science Fiction</ItemTitle>
          <ItemDescription>12,480 members</ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button size="sm" variant="outline">
            Join
          </Button>
        </ItemActions>
      </Item>
      <Item variant="muted">
        <ItemMedia className="h-15" variant="image">
          <img alt="" src={cover} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="font-heading text-base">The Dispossessed</ItemTitle>
          <ItemDescription>Ursula K. Le Guin · 1974</ItemDescription>
        </ItemContent>
      </Item>
    </div>
  ),
};
