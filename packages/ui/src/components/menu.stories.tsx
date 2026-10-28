import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor } from 'storybook/test';
import { Button } from '../shadcn/button.tsx';
import { Menu, type MenuEntry } from './menu.tsx';

// Phone stories are reviewed at 390px; desktop stories are reviewed at 1280px in both themes.

function Example({ entries, title = 'Actions' }: { entries: MenuEntry[]; title?: string }) {
  return <Menu title={title} backLabel="Back" entries={entries} trigger={<Button>Open menu</Button>} />;
}
function RadioExample() {
  const [value, setValue] = useState('planned');
  return (
    <Example
      title="Status"
      entries={[
        {
          type: 'radio',
          label: 'Status',
          value,
          onValueChange: setValue,
          options: [
            { value: 'planned', label: 'Planned' },
            { value: 'reading', label: 'Reading' },
            { value: 'completed', label: 'Completed' },
          ],
        },
      ]}
    />
  );
}
const meta = { title: 'Rezics UI/Menu', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const open: Story['play'] = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
  await waitFor(() => expect(screen.queryByRole('menu') ?? screen.queryByRole('dialog')).not.toBeNull());
};
const phone = { viewport: { defaultViewport: 'phone' } };
const plain: MenuEntry[] = [
  { type: 'item', label: 'Open', onSelect: () => {} },
  { type: 'link', label: 'Visit subject', href: '/subjects/example' },
  { type: 'separator' },
  { type: 'item', label: 'Copy link', onSelect: () => {} },
];
export const PlainEntries: Story = {
  args: { entries: plain },
  parameters: phone,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const panel = await screen.findByRole('dialog');
    const labels = [...panel.querySelectorAll('button, a')].map((row) => row.textContent?.trim()).filter(Boolean);
    await expect(labels).toEqual(['Open', 'Visit subject', 'Copy link']);
  },
};
export const PlainEntriesDark: Story = { ...PlainEntries, globals: { theme: 'dark' } };
export const SubmenuPage: Story = {
  args: {
    entries: [
      { type: 'submenu', label: 'Status', entries: [{ type: 'item', label: 'Completed', onSelect: () => {} }] },
    ],
  },
  parameters: phone,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Status' }));
    await expect(await screen.findByRole('button', { name: 'Back' })).toBeVisible();
    await expect(await screen.findByText('Completed')).toBeVisible();
  },
};
export const BrowserBack: Story = {
  args: {
    entries: [
      { type: 'submenu', label: 'Status', entries: [{ type: 'item', label: 'Completed', onSelect: () => {} }] },
    ],
  },
  parameters: phone,
  play: async () => {
    const trigger = await screen.findByRole('button', { name: 'Open menu' });
    const route = window.location.href;
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('button', { name: 'Status' }));
    window.history.back();
    await waitFor(() => expect(screen.queryByText('Completed')).not.toBeInTheDocument());
    await expect(screen.getByRole('button', { name: 'Back' })).toBeVisible();
    window.history.back();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await expect(window.location.href).toBe(route);
    await expect(trigger).toHaveFocus();
  },
};
export const RadioEntries: Story = {
  args: { entries: [] },
  render: () => <RadioExample />,
  parameters: phone,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const planned = await screen.findByRole('radio', { name: 'Planned' });
    await expect(planned).toBeChecked();
    await userEvent.click(await screen.findByRole('radio', { name: 'Reading' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeVisible());
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    await expect(await screen.findByRole('radio', { name: 'Reading' })).toBeChecked();
  },
};
export const RadioDropdown: Story = {
  args: { entries: [] },
  render: () => <RadioExample />,
  parameters: { viewport: { defaultViewport: 'desktop' } },
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    await expect(await screen.findByRole('menuitemradio', { name: 'Planned' })).toBeChecked();
    const menu = screen.getByRole('menu');
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Reading' }));
    await waitFor(() => expect(menu).not.toBeVisible());
  },
};
export const DestructiveEntry: Story = {
  args: { entries: [{ type: 'destructive', label: 'Remove', onSelect: () => {} }] },
  parameters: phone,
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Open menu' }));
    const remove = await screen.findByRole('button', { name: 'Remove' });
    await expect(remove).toHaveClass(/text-destructive/);
  },
};
export const DesktopDropdown: Story = {
  args: { entries: plain },
  parameters: { viewport: { defaultViewport: 'desktop' } },
  play: open,
};
export const DesktopDropdownDark: Story = { ...DesktopDropdown, globals: { theme: 'dark' } };
