import type { Meta, StoryObj } from '@storybook/react-vite';
import { CompassIcon, HomeIcon, InboxIcon, LibraryIcon, PlusIcon } from 'lucide-react';
import React from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { withTheme } from '../stories/support.tsx';
import {
  BottomNavigation,
  BottomNavigationItem,
  BottomNavigationItemIcon,
  BottomNavigationItemLabel,
  BottomNavigationList,
} from './bottom-navigation.tsx';

const meta = {
  title: 'Rezics UI/Bottom Navigation',
  component: BottomNavigation,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    padded: false,
    docs: {
      story: { inline: false, iframeHeight: 320 },
    },
  },
} satisfies Meta<typeof BottomNavigation>;
export default meta;
type Story = StoryObj<typeof meta>;

type Labels = Record<'home' | 'discover' | 'create' | 'inbox' | 'shelves' | 'bar', string>;

const english: Labels = {
  home: 'Home',
  discover: 'Discover',
  create: 'Create',
  inbox: 'Inbox',
  shelves: 'Shelves',
  bar: 'Primary',
};

type Destination = Exclude<keyof Labels, 'bar'>;

const icons: Record<Destination, React.ReactNode> = {
  home: <HomeIcon />,
  discover: <CompassIcon />,
  create: <PlusIcon />,
  inbox: <InboxIcon />,
  shelves: <LibraryIcon />,
};

// Stands in for the router: links set the current page instead of navigating.
const PhoneNavigation = (
  props: React.ComponentProps<typeof BottomNavigation> & {
    current?: Destination;
    labels?: Labels;
    unread?: boolean;
  },
) => {
  const { current: initial = 'home', labels = english, unread = true, ...rest } = props;
  const [current, setCurrent] = React.useState<Destination>(initial);

  return (
    <div className="min-h-80">
      <p className="p-4 text-muted-foreground text-sm">Feed content scrolls behind the bar.</p>
      <BottomNavigation aria-label={labels.bar} {...rest}>
        <BottomNavigationList>
          {(Object.keys(icons) as Destination[]).map((destination) => (
            <BottomNavigationItem
              active={current === destination}
              href={`#${destination}`}
              key={destination}
              onClick={(event) => {
                event.preventDefault();
                setCurrent(destination);
              }}
            >
              {destination === 'create' ? (
                // Create is the emphasised centre action: a filled ink-blue pill around the icon.
                <BottomNavigationItemIcon className="h-8 bg-primary text-primary-foreground shadow-(--aura-shadow-card) in-aria-[current=page]:bg-primary">
                  {icons.create}
                </BottomNavigationItemIcon>
              ) : (
                <BottomNavigationItemIcon className="relative">
                  {icons[destination]}
                  {destination === 'inbox' && unread ? (
                    <span className="absolute end-3 top-0.5 size-2 rounded-full bg-brand ring-2 ring-background" />
                  ) : null}
                </BottomNavigationItemIcon>
              )}
              <BottomNavigationItemLabel>
                {labels[destination]}
                {destination === 'inbox' && unread ? (
                  <span className="sr-only"> (unread)</span>
                ) : null}
              </BottomNavigationItemLabel>
            </BottomNavigationItem>
          ))}
        </BottomNavigationList>
      </BottomNavigation>
    </div>
  );
};

export const Default: Story = {
  render: (args) => <PhoneNavigation {...args} />,
  async play({ canvasElement }) {
    const bar = within(canvasElement).getByRole('navigation', { name: 'Primary' });
    await expect(within(bar).getAllByRole('link')).toHaveLength(5);
    await expect(within(bar).getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(within(bar).getByRole('link', { name: 'Inbox (unread)' })).toBeVisible();
  },
};

export const Navigate: Story = {
  render: (args) => <PhoneNavigation {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('link', { name: 'Shelves' }));
    await expect(canvas.getByRole('link', { name: 'Shelves' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(canvas.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  },
};

export const KeyboardNavigation: Story = {
  render: (args) => <PhoneNavigation {...args} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'Home' })).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: 'Discover' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('link', { name: 'Discover' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

export const CreateCurrent: Story = {
  render: (args) => <PhoneNavigation {...args} current="create" unread={false} />,
};

export const Chinese: Story = {
  render: (args) => (
    <PhoneNavigation
      {...args}
      current="discover"
      labels={{
        home: '首页',
        discover: '发现',
        create: '发布',
        inbox: '消息',
        shelves: '书架',
        bar: '主导航',
      }}
    />
  ),
  async play({ canvasElement }) {
    const bar = within(canvasElement).getByRole('navigation', { name: '主导航' });
    await expect(within(bar).getByRole('link', { name: '发现' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark', padded: false },
};
