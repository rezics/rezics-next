import type { Meta, StoryObj } from '@storybook/react-vite';
import { BookOpenIcon, HomeIcon, LibraryIcon, UsersIcon } from 'lucide-react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { MetaLine } from './meta-line.tsx';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from '@rezics/ui/shadcn/sidebar';
import { withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Sidebar',
  component: SidebarProvider,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { layout: 'fullscreen', padded: false, docs: { story: { inline: false, iframeHeight: 560 } } },
} satisfies Meta<typeof SidebarProvider>;
export default meta;
type Story = StoryObj<typeof meta>;

const Shell = ({
  collapsible = 'offcanvas',
  variant,
  defaultOpen,
}: {
  collapsible?: 'offcanvas' | 'icon' | 'none';
  variant?: 'sidebar' | 'floating' | 'inset';
  defaultOpen?: boolean;
}) => (
  <SidebarProvider defaultOpen={defaultOpen} style={{ minHeight: 520 }}>
    <Sidebar collapsible={collapsible} variant={variant} aria-label="Primary">
      <SidebarHeader className="px-4 py-3 text-sm font-semibold group-data-[collapsible=icon]:hidden">
        REZICS
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Browse</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive tooltip="Home" render={<a href="#home" />}>
                  <HomeIcon />
                  <span>Home</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Works" render={<a href="#works" />}>
                  <BookOpenIcon />
                  <span>Works</span>
                </SidebarMenuButton>
                <SidebarMenuBadge>12</SidebarMenuBadge>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton render={<a href="#books" />}>
                      <span>Books</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton render={<a href="#cjk" />}>
                      <span>轻小说与漫画：长标题作品合集</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="People" render={<a href="#people" />}>
                  <UsersIcon />
                  <span>People</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton disabled>
                  <LibraryIcon />
                  <span>Library</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-4 py-3 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        <MetaLine items={['v1', '书架']} />
      </SidebarFooter>
    </Sidebar>
    <SidebarInset>
      <header className="flex items-center gap-2 border-b p-3">
        <SidebarTrigger />
        <span className="text-sm font-medium">Works</span>
      </header>
      <p className="p-4 text-sm">Main content</p>
    </SidebarInset>
  </SidebarProvider>
);

const sidebar = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-slot="sidebar"]')!;

export const Default: Story = {
  render: () => <Shell />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Home' })).toHaveAttribute('data-active');
    await expect(canvas.getByRole('link', { name: /轻小说与漫画/ })).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Library' })).toBeDisabled();
    await expect(sidebar(canvasElement)).toHaveAttribute('data-state', 'expanded');
  },
};

export const Toggle: Story = {
  render: () => <Shell />,
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Toggle Sidebar' });
    await userEvent.click(trigger);
    await waitFor(() => expect(sidebar(canvasElement)).toHaveAttribute('data-state', 'collapsed'));
    await userEvent.click(trigger);
    await waitFor(() => expect(sidebar(canvasElement)).toHaveAttribute('data-state', 'expanded'));
  },
};

export const IconOnly: Story = {
  render: () => <Shell collapsible="icon" defaultOpen={false} />,
  async play({ canvasElement }) {
    await expect(sidebar(canvasElement)).toHaveAttribute('data-collapsible', 'icon');
    await expect(sidebar(canvasElement)).toHaveAttribute('data-state', 'collapsed');
    await expect(within(canvasElement).getByRole('link', { name: 'Works' })).toBeInTheDocument();
  },
};

export const Inset: Story = {
  render: () => <Shell variant="inset" />,
  async play({ canvasElement }) {
    await expect(sidebar(canvasElement)).toHaveAttribute('data-variant', 'inset');
  },
};

export const Fixed: Story = {
  render: () => <Shell collapsible="none" />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'People' })).toBeInTheDocument();
  },
};
