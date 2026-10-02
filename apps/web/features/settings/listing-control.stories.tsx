import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { accessActor, captureAccessStory } from '../manage/settings-fixtures.ts';
import { PersonListingControl } from './listing-control.tsx';

const initial = { listing: 'listed' as const, version: 3, changedAt: null };
const meta = { title: 'Settings/Person listing', component: PersonListingControl,
  args: { agent: accessActor, locale: 'en', initial, api: {
    read: async () => ({ ok: true as const, data: initial }),
    save: async (listing: 'listed' | 'unlisted', expectedVersion: number) => ({ ok: true as const,
      data: { listing, version: expectedVersion + 1, changedAt: '2026-10-02T08:00:00Z' } }),
  } }, decorators: [Story => <div className="mx-auto max-w-2xl p-4 sm:p-8"><Story /></div>],
} satisfies Meta<typeof PersonListingControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = {};
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const Korean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' } };
export const German: Story = { args: { locale: 'de' }, globals: { locale: 'de' } };
export const French: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' } };
export const Spanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' } };
export const UnlistAndSave: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('switch', { name: 'Unlist my profile' }));
    await expect(canvas.getByText(/Your profile still opens by link/)).toBeVisible();
    await expect(canvas.getByRole('switch')).toBeChecked();
    await expect(canvas.getByRole('button', { name: 'Save listing' })).toBeEnabled();
    await captureAccessStory('person-unlisted');
    await userEvent.click(canvas.getByRole('button', { name: 'Save listing' }));
    await expect(await canvas.findByText('Settings saved.')).toBeVisible();
    await expect(canvas.getByRole('switch')).toBeChecked();
  },
};
export const ConcurrentChange: Story = {
  args: { api: { read: async () => ({ ok: true, data: { listing: 'unlisted', version: 4, changedAt: null } }),
    save: async () => ({ ok: false, failure: 'stale' }) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('switch'));
    await userEvent.click(canvas.getByRole('button', { name: 'Save listing' }));
    await expect(await canvas.findByText(/Your listing changed elsewhere/)).toBeVisible();
    await expect(canvas.getByRole('switch')).toBeChecked();
    await expect(canvas.getByRole('button', { name: 'Save listing' })).toBeDisabled();
  },
};
