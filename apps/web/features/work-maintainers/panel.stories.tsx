import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { copyOf } from './messages.ts';
import { MaintainerPanel, type MaintainerNotice } from './panel.tsx';
import { maintainerRows } from './rules.ts';

const owner = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a1';
const maren = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a2';
const lin = 'https://rezics.com/id/00000000-0000-4000-8000-0000000000a3';
const names = {
  [owner]: { displayName: 'Ada Lovelace', handle: 'ada' },
  [maren]: { displayName: 'Maren Osei', handle: 'maren' },
  [lin]: { displayName: '林晓', handle: null },
};
const t = copyOf('en');
const quiet = { draft: '', fieldError: null as string | null, notice: null as MaintainerNotice | null, pending: null,
  confirming: null, reloading: false, t, onDraft() {}, onAdd() {}, onAskRemove() {}, onConfirmRemove() {},
  onCancelRemove() {}, onReload() {} };

const meta = {
  title: 'Work/Maintainers',
  component: MaintainerPanel,
  args: { ...quiet, canAdd: true, rows: maintainerRows({ viewer: owner, owner, maintainers: [owner, maren, lin], names }) },
} satisfies Meta<typeof MaintainerPanel>;
export default meta;

type Story = StoryObj<typeof meta>;

/** The owner sees Remove on every co-maintainer, and never on their own row. */
export const Owner: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Maintainers' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Remove Maren Osei' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Remove 林晓' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Remove Ada Lovelace' })).toBeNull();
    await expect(canvas.getByText('Owner')).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  },
};

/** Opening Remove states the consequence before anything is written. */
export const Confirm: Story = {
  globals: { viewport: { value: 'phone' } },
  args: {
    confirming: maintainerRows({ viewer: owner, owner, maintainers: [owner, maren], names })
      .find(row => row.id === maren) ?? null,
  },
  async play() {
    const dialog = await within(document.body).findByRole('alertdialog');
    await expect(dialog).toHaveTextContent('Maren Osei will no longer be able to edit this Work');
    await expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeVisible();
    await expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeVisible();
  },
};

/** A co-maintainer can add someone and is not offered Remove. */
export const CoMaintainer: Story = {
  globals: { viewport: { value: 'phone' } },
  args: { rows: maintainerRows({ viewer: maren, owner, maintainers: [owner, maren], names }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Add' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /Remove/ })).toBeNull();
  },
};

/** The only maintainer is the owner: Add stays, Remove does not. */
export const LastMaintainer: Story = {
  args: { rows: maintainerRows({ viewer: owner, owner, maintainers: [owner], names }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: /Remove/ })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Add' })).toBeVisible();
  },
};

/** A generation conflict keeps the typed handle and offers the latest list. */
export const Conflict: Story = {
  globals: { viewport: { value: 'phone' } },
  args: {
    draft: '@lin_mei',
    notice: { kind: 'stale' },
    rows: maintainerRows({ viewer: owner, owner, maintainers: [owner, maren], names }),
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent('This list changed since you opened it');
    await expect(canvas.getByRole('button', { name: 'Reload latest' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Add a maintainer' })).toHaveValue('@lin_mei');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  },
};
