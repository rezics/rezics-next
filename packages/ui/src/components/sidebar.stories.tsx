import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  CompassIcon,
  EllipsisIcon,
  HomeIcon,
  InboxIcon,
  LibraryIcon,
  PlusIcon,
  ShieldIcon,
  UsersIcon,
} from 'lucide-react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { settled, withTheme } from '../stories/support.tsx';
import { Avatar, AvatarFallback } from './avatar.tsx';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from './sidebar.tsx';

const meta = {
  title: 'Rezics UI/Sidebar',
  component: Sidebar,
  tags: ['autodocs'],
  decorators: [withTheme],
  parameters: {
    padded: false,
    docs: {
      description: {
        component:
          'The desktop left navigation of the REZICS shell: Home, Discover, Inbox and Shelves, the reader’s Realms, and moderation tools for moderators, with the acting identity at the foot. It collapses to icons (with tooltips) or off-canvas, toggles with ⌘B / Ctrl+B, and below 768px becomes a sheet opened by `SidebarTrigger`, alongside the phone bottom navigation. Wrap the menu in a `nav` landmark and mark the current page with `isActive`.',
      },
      story: { inline: false, iframeHeight: 560 },
    },
  },
} satisfies Meta<typeof Sidebar>;
export default meta;
type Story = StoryObj<typeof meta>;

interface ShellProps extends React.ComponentProps<typeof Sidebar> {
  defaultOpen?: boolean;
  loading?: boolean;
}

const browse = [
  { label: 'Home', icon: <HomeIcon />, active: true },
  { label: 'Discover', icon: <CompassIcon /> },
  { label: 'Inbox', icon: <InboxIcon />, badge: '3' },
];

const realms = ['Hard SF', 'Translated Fiction', 'Chinese Science Fiction Readers’ Circle'];

const Shell = (props: ShellProps) => {
  const { defaultOpen = true, loading = false, ...sidebar } = props;

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar {...sidebar}>
        <SidebarHeader>
          <span className="px-2 py-1 font-semibold tracking-[0.3em] group-data-[collapsible=icon]:hidden">
            REZICS
          </span>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label="Main">
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {browse.map((item) => (
                    <SidebarMenuItem key={item.label}>
                      <SidebarMenuButton asChild isActive={item.active} tooltip={item.label}>
                        <a href={`#${item.label.toLowerCase()}`}>
                          {item.icon}
                          <span>{item.label}</span>
                        </a>
                      </SidebarMenuButton>
                      {item.badge ? (
                        <SidebarMenuBadge>
                          {item.badge}
                          <span className="sr-only"> unread</span>
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  ))}
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="Shelves">
                      <a href="#shelves">
                        <LibraryIcon />
                        <span>Shelves</span>
                      </a>
                    </SidebarMenuButton>
                    <SidebarMenuSub>
                      {['Want to read', 'Reading', 'Read'].map((shelf) => (
                        <SidebarMenuSubItem key={shelf}>
                          <SidebarMenuSubButton href={`#${shelf}`}>
                            <span>{shelf}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarSeparator />
            <SidebarGroup>
              <SidebarGroupLabel>Your Realms</SidebarGroupLabel>
              <SidebarGroupAction aria-label="Join a Realm" title="Join a Realm">
                <PlusIcon />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  {loading
                    ? [0, 1, 2].map((index) => (
                        <SidebarMenuItem key={index}>
                          <SidebarMenuSkeleton showIcon />
                        </SidebarMenuItem>
                      ))
                    : realms.map((realm) => (
                        <SidebarMenuItem key={realm}>
                          <SidebarMenuButton asChild tooltip={realm}>
                            <a href={`#${realm}`}>
                              <UsersIcon />
                              <span>{realm}</span>
                            </a>
                          </SidebarMenuButton>
                          <SidebarMenuAction aria-label={`${realm} options`}>
                            <EllipsisIcon />
                          </SidebarMenuAction>
                        </SidebarMenuItem>
                      ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Moderation</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton asChild tooltip="Report queue">
                      <a href="#reports">
                        <ShieldIcon />
                        <span>Report queue</span>
                      </a>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>24</SidebarMenuBadge>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </nav>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" tooltip="Ye Wenjie">
                <Avatar size="md">
                  <AvatarFallback>YW</AvatarFallback>
                </Avatar>
                <span className="flex min-w-0 flex-col text-start leading-tight">
                  <span className="truncate font-medium">Ye Wenjie</span>
                  <span className="truncate text-muted-foreground text-xs">Acting as moderator</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b border-border/60 px-4">
          <SidebarTrigger />
          <span className="font-medium text-sm">Home</span>
        </header>
        {/* SidebarInset is the main landmark. */}
        <div className="p-6 text-sm">
          <h1 className="font-semibold text-lg">Your feed</h1>
          <p className="text-muted-foreground">New posts from Hard SF and Translated Fiction.</p>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
};

// Below 768px the sidebar is a closed sheet until the trigger opens it.
const isPhone = () => window.innerWidth < 768;

// The pointer-only rail shares the trigger's name, so find the trigger by its slot.
const trigger = (canvasElement: HTMLElement) =>
  canvasElement.querySelector<HTMLElement>('[data-slot=sidebar-trigger]') as HTMLElement;

const openIfPhone = async (canvasElement: HTMLElement) => {
  if (!isPhone()) return canvasElement;
  await userEvent.click(trigger(canvasElement));
  return settled(await screen.findByRole('dialog'));
};

export const Default: Story = {
  render: (args) => <Shell {...args} />,
  async play({ canvasElement }) {
    const scope = within(await openIfPhone(canvasElement));
    const main = scope.getByRole('navigation', { name: 'Main' });
    await expect(within(main).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await expect(within(main).getByRole('link', { name: 'Hard SF' })).toBeVisible();
  },
};

export const Toggle: Story = {
  render: (args) => <Shell {...args} />,
  async play({ canvasElement }) {
    if (isPhone()) {
      await openIfPhone(canvasElement);
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      return;
    }
    const sidebar = canvasElement.querySelector('[data-slot=sidebar]');
    await expect(trigger(canvasElement)).toHaveAccessibleName('Toggle Sidebar');
    await userEvent.click(trigger(canvasElement));
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  },
};

export const KeyboardShortcut: Story = {
  render: (args) => <Shell {...args} />,
  async play({ canvasElement }) {
    await userEvent.keyboard('{Control>}b{/Control}');
    if (isPhone()) {
      await expect(await screen.findByRole('dialog')).toBeInTheDocument();
    } else {
      await expect(canvasElement.querySelector('[data-slot=sidebar]')).toHaveAttribute(
        'data-state',
        'collapsed',
      );
    }
  },
};

export const IconCollapsed: Story = {
  args: { collapsible: 'icon' },
  render: (args) => <Shell {...args} defaultOpen={false} />,
  async play({ canvasElement }) {
    if (isPhone()) return;
    await userEvent.hover(within(canvasElement).getByRole('link', { name: 'Discover' }));
    await expect(await screen.findByRole('tooltip')).toHaveTextContent('Discover');
  },
};

export const Floating: Story = {
  args: { variant: 'floating' },
  render: (args) => <Shell {...args} />,
  play: Default.play,
};

export const Inset: Story = {
  args: { variant: 'inset' },
  render: (args) => <Shell {...args} />,
  play: Default.play,
};

export const Right: Story = {
  args: { placement: 'right' },
  render: (args) => <Shell {...args} />,
  play: Default.play,
};

export const Loading: Story = {
  render: (args) => <Shell {...args} loading />,
};

export const Chinese: Story = {
  render: (args) => (
    <SidebarProvider>
      <Sidebar {...args}>
        <SidebarContent>
          <nav aria-label="主导航">
            <SidebarGroup>
              <SidebarGroupLabel>我的 Realm</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {['科幻', '「三体」读书会', 'Hard SF 中文讨论区'].map((realm, index) => (
                    <SidebarMenuItem key={realm}>
                      <SidebarMenuButton asChild isActive={index === 1}>
                        <a href={`#${realm}`}>
                          <UsersIcon />
                          <span>{realm}</span>
                        </a>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </nav>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-14 items-center gap-2 border-b border-border/60 px-4">
          <SidebarTrigger label="切换侧边栏" />
          <span className="font-medium text-sm">《三体》读书会</span>
        </header>
      </SidebarInset>
    </SidebarProvider>
  ),
  async play({ canvasElement }) {
    if (isPhone()) {
      await userEvent.click(within(canvasElement).getByRole('button', { name: '切换侧边栏' }));
    }
    const nav = await screen.findByRole('navigation', { name: '主导航' });
    await expect(within(nav).getByRole('link', { name: '「三体」读书会' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  },
};

export const Dark: Story = {
  ...Default,
  parameters: { theme: 'dark', padded: false },
};
