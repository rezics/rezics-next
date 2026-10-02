import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { accessActor, accessFixtureApi, captureAccessStory, joinPageFixture, requestFixture } from '../manage/settings-fixtures.ts';
import { PrivateSpaceJoinPage } from './join-page.tsx';

const meta = { title: 'Space access/Join', component: PrivateSpaceJoinPage,
  args: { page: joinPageFixture, actingSubject: accessActor, signInHref: '/sign-in', locale: 'en', persist: false, api: accessFixtureApi() },
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
export const Pending: Story = { args: { state: 'pending', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } } };
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
      return { ok: true, data: { requestId: '00000000-0000-4000-8000-000000000021', replayed: true, state: 'pending', requestGeneration: '0' } };
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

export const Withdraw: Story = {
  args: { receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Withdraw request' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'I cannot join this month.');
    await userEvent.click(dialog.getByRole('button', { name: 'Withdraw request' }));
    await expect(await canvas.findByText('Your request was withdrawn.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Request to join' })).toBeVisible();
  },
};
export const WithdrawalStale: Story = {
  args: { receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' },
    api: accessFixtureApi({ withdraw: async () => ({ ok: false, failure: 'stale' }) }) },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Withdraw request' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Plans changed.');
    await userEvent.click(dialog.getByRole('button', { name: 'Withdraw request' }));
    await expect(await dialog.findByText('This request is no longer pending. Its current result could not be loaded.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Withdraw request' })).toBeDisabled();
  },
};
export const PendingEnglish: Story = { args: { locale: 'en', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } }, globals: { locale: 'en' } };
export const DeclinedEnglish: Story = { args: { locale: 'en', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'declined' } }, globals: { locale: 'en' } };
export const WithdrawnEnglish: Story = { args: { locale: 'en', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'withdrawn' } }, globals: { locale: 'en' } };
export const AcceptedEnglish: Story = { args: { locale: 'en', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'accepted' } }, globals: { locale: 'en' } };
export const SignedOutEnglish: Story = { args: { locale: 'en', actingSubject: null }, globals: { locale: 'en' } };
export const PendingTraditionalChinese: Story = { args: { locale: 'zh-Hant', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } }, globals: { locale: 'zh-Hant' } };
export const DeclinedTraditionalChinese: Story = { args: { locale: 'zh-Hant', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'declined' } }, globals: { locale: 'zh-Hant' } };
export const WithdrawnTraditionalChinese: Story = { args: { locale: 'zh-Hant', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'withdrawn' } }, globals: { locale: 'zh-Hant' } };
export const AcceptedTraditionalChinese: Story = { args: { locale: 'zh-Hant', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'accepted' } }, globals: { locale: 'zh-Hant' } };
export const SignedOutTraditionalChinese: Story = { args: { locale: 'zh-Hant', actingSubject: null }, globals: { locale: 'zh-Hant' } };
export const PendingSimplifiedChinese: Story = { args: { locale: 'zh-Hans', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } }, globals: { locale: 'zh-Hans' } };
export const DeclinedSimplifiedChinese: Story = { args: { locale: 'zh-Hans', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'declined' } }, globals: { locale: 'zh-Hans' } };
export const WithdrawnSimplifiedChinese: Story = { args: { locale: 'zh-Hans', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'withdrawn' } }, globals: { locale: 'zh-Hans' } };
export const AcceptedSimplifiedChinese: Story = { args: { locale: 'zh-Hans', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'accepted' } }, globals: { locale: 'zh-Hans' } };
export const SignedOutSimplifiedChinese: Story = { args: { locale: 'zh-Hans', actingSubject: null }, globals: { locale: 'zh-Hans' } };
export const PendingJapanese: Story = { args: { locale: 'ja', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } }, globals: { locale: 'ja' } };
export const DeclinedJapanese: Story = { args: { locale: 'ja', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'declined' } }, globals: { locale: 'ja' } };
export const WithdrawnJapanese: Story = { args: { locale: 'ja', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'withdrawn' } }, globals: { locale: 'ja' } };
export const AcceptedJapanese: Story = { args: { locale: 'ja', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'accepted' } }, globals: { locale: 'ja' } };
export const SignedOutJapanese: Story = { args: { locale: 'ja', actingSubject: null }, globals: { locale: 'ja' } };
export const PendingKorean: Story = { args: { locale: 'ko', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } }, globals: { locale: 'ko' } };
export const DeclinedKorean: Story = { args: { locale: 'ko', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'declined' } }, globals: { locale: 'ko' } };
export const WithdrawnKorean: Story = { args: { locale: 'ko', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'withdrawn' } }, globals: { locale: 'ko' } };
export const AcceptedKorean: Story = { args: { locale: 'ko', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'accepted' } }, globals: { locale: 'ko' } };
export const SignedOutKorean: Story = { args: { locale: 'ko', actingSubject: null }, globals: { locale: 'ko' } };
export const PendingGerman: Story = { args: { locale: 'de', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } }, globals: { locale: 'de' } };
export const DeclinedGerman: Story = { args: { locale: 'de', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'declined' } }, globals: { locale: 'de' } };
export const WithdrawnGerman: Story = { args: { locale: 'de', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'withdrawn' } }, globals: { locale: 'de' } };
export const AcceptedGerman: Story = { args: { locale: 'de', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'accepted' } }, globals: { locale: 'de' } };
export const SignedOutGerman: Story = { args: { locale: 'de', actingSubject: null }, globals: { locale: 'de' } };
export const PendingFrench: Story = { args: { locale: 'fr', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } }, globals: { locale: 'fr' } };
export const DeclinedFrench: Story = { args: { locale: 'fr', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'declined' } }, globals: { locale: 'fr' } };
export const WithdrawnFrench: Story = { args: { locale: 'fr', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'withdrawn' } }, globals: { locale: 'fr' } };
export const AcceptedFrench: Story = { args: { locale: 'fr', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'accepted' } }, globals: { locale: 'fr' } };
export const SignedOutFrench: Story = { args: { locale: 'fr', actingSubject: null }, globals: { locale: 'fr' } };
export const PendingSpanish: Story = { args: { locale: 'es', receipt: { requestId: requestFixture.id, requestGeneration: '0', state: 'pending' } }, globals: { locale: 'es' } };
export const DeclinedSpanish: Story = { args: { locale: 'es', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'declined' } }, globals: { locale: 'es' } };
export const WithdrawnSpanish: Story = { args: { locale: 'es', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'withdrawn' } }, globals: { locale: 'es' } };
export const AcceptedSpanish: Story = { args: { locale: 'es', receipt: { requestId: requestFixture.id, requestGeneration: '1', state: 'accepted' } }, globals: { locale: 'es' } };
export const SignedOutSpanish: Story = { args: { locale: 'es', actingSubject: null }, globals: { locale: 'es' } };

/** Browser journeys intercept the real BFF client; no separate route is mounted. */
export const BrowserRequest: Story = { name: 'Browser request', args: { api: undefined, persist: true } };

export const ChangedAdmissionRules: Story = {
  args: { api: accessFixtureApi({ request: async () => ({ ok: false, failure: 'stale' }) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('textbox'), 'I accept the rules.');
    await userEvent.click(canvas.getByRole('button', { name: 'Request to join' }));
    await expect(await canvas.findByText('The admission rules or your membership changed. Reload the community rules before trying again.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Request to join' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Reload community rules' })).toBeVisible();
    await expect(canvas.getByRole('textbox')).toHaveValue('I accept the rules.');
  },
};
