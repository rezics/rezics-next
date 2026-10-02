import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { accessActor, accessFixtureApi, captureAccessStory, joinPageFixture } from '../manage/settings-fixtures.ts';
import { PrivateSpaceJoinPage } from './join-page.tsx';

const meta = { title: 'Space access/Join', component: PrivateSpaceJoinPage,
  args: { page: joinPageFixture, actingSubject: accessActor, signInHref: '/sign-in', locale: 'en', api: accessFixtureApi() },
} satisfies Meta<typeof PrivateSpaceJoinPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = { async play() { await captureAccessStory('join'); } };
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const Korean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' } };
export const German: Story = { args: { locale: 'de' }, globals: { locale: 'de' } };
export const French: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' } };
export const Spanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' } };
export const RequestToPending: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Respect other readers' })).toBeVisible();
    await expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
    await userEvent.type(canvas.getByRole('textbox'), 'I read and accept the community rules.');
    await userEvent.click(canvas.getByRole('button', { name: 'Request to join' }));
    await expect(await canvas.findByText('Your request is pending. A manager will review it.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Request to join' })).not.toBeInTheDocument();
    await captureAccessStory('join-pending');
  },
};
export const Declined: Story = { args: { state: 'declined' }, async play() { await captureAccessStory('join-declined'); } };
export const Pending: Story = { args: { state: 'pending' } };
export const SignedOut: Story = { args: { actingSubject: null }, async play({ canvasElement }) {
  await expect(within(canvasElement).getByRole('link', { name: 'Sign in to request to join' })).toHaveAttribute('href', '/sign-in');
} };
export const LostResponseRetry: Story = {
  args: { api: (() => {
    let calls = 0;
    let intent: string | null = null;
    return accessFixtureApi({ request: async (command, key) => {
      const body = JSON.stringify([command, key]);
      if (calls++ === 0) { intent = body; return { ok: false, failure: 'unavailable' }; }
      await expect(body).toBe(intent);
      return { ok: true, data: { requestId: 'request', replayed: true, state: 'pending', expiresAt: '2026-10-09T08:00:00Z' } };
    } });
  })() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox'), 'I accept the rules.');
    await userEvent.click(canvas.getByRole('button', { name: 'Request to join' }));
    await expect(await canvas.findByText('Could not complete this. Try again.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Request to join' }));
    await expect(await canvas.findByText('Your request is pending. A manager will review it.')).toBeVisible();
  },
};
