import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@rezics/ui/shadcn/sidebar';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@rezics/ui/shadcn/sheet';
import { waitForFocus } from '../test/focus.ts';
import { dismissed, settled, withSurface } from '../stories/support.tsx';

const meta = {
  title: 'shadcn/Sheet',
  component: Sheet,
  tags: ['autodocs'],
  decorators: [withSurface],
  parameters: { docs: { story: { inline: false, iframeHeight: 520 } } },
} satisfies Meta<typeof Sheet>;
export default meta;
type Story = StoryObj<typeof meta>;

const expectWithinViewport = (panel: HTMLElement) => {
  const bounds = panel.getBoundingClientRect();
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
};

const expectReachableIn = (panel: HTMLElement, target: HTMLElement) => {
  target.scrollIntoView({ block: 'nearest' });
  const panelBounds = panel.getBoundingClientRect();
  const targetBounds = target.getBoundingClientRect();
  expect(targetBounds.top).toBeGreaterThanOrEqual(panelBounds.top);
  expect(targetBounds.bottom).toBeLessThanOrEqual(panelBounds.bottom);
};

const Filters = ({ side }: { side?: 'top' | 'right' | 'bottom' | 'left' }) => (
  <Sheet>
    <SheetTrigger render={<Button variant="outline" />}>Filters</SheetTrigger>
    <SheetContent side={side}>
      <SheetHeader>
        <SheetTitle>Filter Works</SheetTitle>
        <SheetDescription>Narrow the list by author or title.</SheetDescription>
      </SheetHeader>
      <div className="px-6">
        <Field>
          <FieldLabel htmlFor="sheet-author">Author</FieldLabel>
          <Input id="sheet-author" defaultValue="刘慈欣" />
        </Field>
      </div>
      <SheetFooter>
        <Button>Apply filters</Button>
        <SheetClose render={<Button variant="outline" />}>Cancel</SheetClose>
      </SheetFooter>
    </SheetContent>
  </Sheet>
);

export const Default: Story = {
  render: () => <Filters />,
  globals: {},
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Filters' });
    await userEvent.click(trigger);
    const sheet = await settled(await screen.findByRole('dialog', { name: 'Filter Works' }));
    await expect(sheet).toHaveAccessibleDescription('Narrow the list by author or title.');
    await expect(sheet).toHaveAttribute('data-side', 'right');
    expectWithinViewport(sheet);
    await userEvent.keyboard('{Escape}');
    await dismissed('dialog');
    await waitForFocus(trigger);
  },
};

export const Sides: Story = {
  render: () => <Filters side="left" />,
  globals: {},
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filters' }));
    const sheet = await settled(await screen.findByRole('dialog'));
    await expect(sheet).toHaveAttribute('data-side', 'left');
    expectWithinViewport(sheet);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await dismissed('dialog');
  },
};

export const Bottom: Story = {
  render: () => <Filters side="bottom" />,
  globals: {},
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filters' }));
    const sheet = await settled(await screen.findByRole('dialog'));
    await expect(sheet).toHaveAttribute('data-side', 'bottom');
    expectWithinViewport(sheet);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await dismissed('dialog');
  },
};

export const Top: Story = {
  render: () => <Filters side="top" />,
  globals: {},
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Filters' }));
    const sheet = await settled(await screen.findByRole('dialog'));
    await expect(sheet).toHaveAttribute('data-side', 'top');
    expectWithinViewport(sheet);
    await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
    await dismissed('dialog');
  },
};

export const LongCJKContent: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger render={<Button variant="outline" />}>作品详情</SheetTrigger>
      <SheetContent showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>《三体》第三部：死神永生与更多的长标题作品名称</SheetTitle>
          <SheetDescription>
            文明之间的黑暗森林法则：宇宙就是一座黑暗森林，每个文明都是带枪的猎人，像幽灵般潜行于林间。
          </SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <SheetClose render={<Button variant="outline" />}>关闭</SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '作品详情' }));
    const sheet = await settled(await screen.findByRole('dialog', { name: /死神永生/ }));
    await expect(within(sheet).queryByRole('button', { name: 'Close' })).toBeNull();
    await userEvent.click(within(sheet).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  },
};

const longSheetFields = [
  ['sheet-owner', 'Owner', 'Lin Mo'],
  ['sheet-title', 'Title', 'The Three-Body Problem'],
  ['sheet-language', 'Language', '繁體中文'],
  ['sheet-year', 'Year', '2008'],
  ['sheet-series', 'Series', 'Remembrance of Earth’s Past'],
  ['sheet-status', 'Reading status', 'In progress'],
  ['sheet-note', 'Private note', 'A long note that remains editable in the same sheet'],
  ['sheet-reference', 'External reference', 'https://example.test/works/three-body-problem'],
  ['sheet-summary', 'Summary', '作品名稱作品名稱作品名稱作品名稱作品名稱作品名稱作品名稱作品名稱作品名稱'],
] as const;

const LongSheetForm = () => (
  <Sheet>
    <SheetTrigger render={<Button variant="outline" />}>Edit filters</SheetTrigger>
    <SheetContent
      id="sheet-filter-dialog"
      className="sheet-workflow-override"
      style={{ '--sheet-workflow-marker': 'preserved' } as CSSProperties}
      side="bottom"
    >
      <SheetHeader>
        <SheetTitle>Edit collection filters</SheetTitle>
        <SheetDescription>Update the values, then apply or cancel the filter changes.</SheetDescription>
      </SheetHeader>
      <div className="grid min-w-0 gap-5 px-6">
        {longSheetFields.map(([id, label, value]) => (
          <Field key={id}>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            <Input id={id} name={id} defaultValue={value} />
          </Field>
        ))}
      </div>
      <SheetFooter data-testid="sheet-filter-footer">
        <Button>Apply filters</Button>
        <SheetClose render={<Button variant="outline" />}>Cancel</SheetClose>
      </SheetFooter>
    </SheetContent>
  </Sheet>
);

export const LongFormScroll: Story = {
  render: () => <LongSheetForm />,
  globals: {},
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Edit filters' }));
    const sheet = await settled(await screen.findByRole('dialog', { name: 'Edit collection filters' }));
    expect(sheet).toHaveAttribute('id', 'sheet-filter-dialog');
    expect(sheet).toHaveClass('sheet-workflow-override');
    expect(sheet.style.getPropertyValue('--sheet-workflow-marker')).toBe('preserved');
    expect(sheet.scrollHeight).toBeGreaterThan(sheet.clientHeight);
    expectWithinViewport(sheet);

    const lastField = within(sheet).getByLabelText('Summary');
    const close = within(sheet).getByRole('button', { name: 'Close' });
    const footer = within(sheet).getByTestId('sheet-filter-footer');
    expect(getComputedStyle(footer).flexShrink).toBe('0');
    expectReachableIn(sheet, lastField);
    expectReachableIn(sheet, close);
    expectReachableIn(sheet, within(footer).getByRole('button', { name: 'Apply filters' }));
    expectReachableIn(sheet, within(footer).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(footer).getByRole('button', { name: 'Cancel' }));
    await dismissed('dialog');
  },
};

const mobileSidebarPages = [
  'Home',
  'Collections',
  'Reading progress',
  'Finished works',
  'Planned works',
  'Independent labels',
  'Recently updated editions',
  'Saved reading filters',
  'Contributed subjects',
  'Account preferences',
  '作品名稱與作者資料',
  'Long-running discussions',
  'Imported works',
  'Shared with me',
  'Archived collections',
  'Privacy and access',
  'Help and support',
];

const MobileSidebar = () => (
  <SidebarProvider style={{ minHeight: 520 }}>
    <Sidebar>
      <SidebarHeader>Library navigation</SidebarHeader>
      <SidebarContent>
        <nav aria-label="Sidebar pages" className="grid gap-1 px-2">
          {mobileSidebarPages.map((page, index) => (
            <a key={page} className="flex min-h-11 items-center rounded-lg px-3" href={`#sidebar-${index}`}>
              {page}
            </a>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter>Account</SidebarFooter>
    </Sidebar>
    <SidebarInset>
      <header className="flex items-center gap-2 border-b p-3">
        <SidebarTrigger />
        <span>Library</span>
      </header>
      <p className="p-4">Page content</p>
    </SidebarInset>
  </SidebarProvider>
);

export const MobileSidebarCompatibility: Story = {
  render: () => <MobileSidebar />,
  globals: {},
  async play({ canvasElement }) {
    const trigger = within(canvasElement).getByRole('button', { name: 'Toggle Sidebar' });
    await userEvent.click(trigger);
    const dialog = await settled(await screen.findByRole('dialog', { name: 'Sidebar' }));
    expectWithinViewport(dialog);
    const panel = document.querySelector<HTMLElement>('[data-slot="sidebar"][data-mobile="true"]')!;
    expect(panel).toHaveClass('w-(--sidebar-width)', 'p-0');
    expect(panel.style.getPropertyValue('--sidebar-width')).toBe('18rem');
    expect(panel.getBoundingClientRect().width).toBe(288);
    const closeButton = dialog.querySelector<HTMLElement>('[data-slot="sheet-close"]');
    expect(closeButton).not.toBeNull();
    expect(getComputedStyle(closeButton!).display).toBe('none');

    const content = panel.querySelector<HTMLElement>('[data-slot="sidebar-content"]')!;
    expect(getComputedStyle(content).overflowY).toBe('auto');
    expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);
    expect(dialog.scrollHeight).toBeLessThanOrEqual(dialog.clientHeight);
    const finalPage = within(content).getByRole('link', { name: 'Help and support' });
    finalPage.scrollIntoView({ block: 'nearest' });
    const contentBounds = content.getBoundingClientRect();
    const finalPageBounds = finalPage.getBoundingClientRect();
    expect(finalPageBounds.top).toBeGreaterThanOrEqual(contentBounds.top);
    expect(finalPageBounds.bottom).toBeLessThanOrEqual(contentBounds.bottom);
    await userEvent.keyboard('{Escape}');
    await dismissed('dialog');
    await waitForFocus(trigger);
  },
};
