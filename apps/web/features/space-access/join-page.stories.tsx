import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { accessActor, accessFixtureApi, captureAccessStory, joinPageFixture, ownRequestFixture } from '../manage/settings-fixtures.ts';
import { emptyRequestJournal, requestStorageKey } from './request-state.ts';
import { PrivateSpaceJoinPage } from './join-page.tsx';
import { signInPath } from '../auth/paths.ts';
import { accessMessages } from '../manage/settings-messages.ts';

const meta = { title: 'Space access/Join', component: PrivateSpaceJoinPage,
  args: { page: joinPageFixture, actingSubject: accessActor, signInHref: '/sign-in', locale: 'en', persist: false },
  render: args => <PrivateSpaceJoinPage {...args} api={args.api ?? accessFixtureApi()} />,
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
    await userEvent.type(await canvas.findByRole('textbox'), 'I read and accept the community rules.');
    await userEvent.click(canvas.getByRole('button', { name: 'Request to join' }));
    await expect(await canvas.findByText('Your request is pending. A manager will review it.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Request to join' })).not.toBeInTheDocument();
    await captureAccessStory('join-pending');
  },
};
export const Declined: Story = { args: { api: accessFixtureApi({}, ownRequestFixture('declined')) }, async play() { await captureAccessStory('join-declined'); } };
export const Pending: Story = { args: { api: accessFixtureApi({}, ownRequestFixture('pending')) } };
export const SignedOut: Story = { args: { actingSubject: null, signInHref: signInPath('/en/r/private-books') }, async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('link', { name: 'Sign in to request to join' })).toHaveAttribute('href', signInPath('/en/r/private-books'));
  await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
  await expect(canvas.queryByText(accessMessages.en.statusLoading)).not.toBeInTheDocument();
  await captureAccessStory('g-988-join-signed-out-en');
} };
export const LostResponseRetry: Story = {
  args: { api: (() => {
    let calls = 0;
    let intent: string | null = null;
    return accessFixtureApi({ mine: async () => ({ ok: true, data: calls > 1 ? ownRequestFixture('pending') : { items: [], nextCursor: null, complete: true } }),
      request: async (command, key) => {
      const body = JSON.stringify([command, key]);
      if (calls++ === 0) { intent = body; return { ok: false, failure: 'unavailable' }; }
      await expect(body).toBe(intent);
      return { ok: true, data: { requestId: '00000000-0000-4000-8000-000000000021', replayed: true, state: 'pending', requestGeneration: '0' } };
    } });
  })() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox'), 'I accept the rules.');
    await userEvent.click(canvas.getByRole('button', { name: 'Request to join' }));
    await expect(await canvas.findByText('Could not complete this. Try again.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Request to join' }));
    await expect(await canvas.findByText('Your request is pending. A manager will review it.')).toBeVisible();
  },
};

export const Withdraw: Story = {
  args: { api: accessFixtureApi({}, ownRequestFixture('pending')) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Withdraw request' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'I cannot join this month.');
    await userEvent.click(dialog.getByRole('button', { name: 'Withdraw request' }));
    await expect(await canvas.findByText('Your request was withdrawn.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Request to join' })).toBeVisible();
  },
};
export const WithdrawalStale: Story = {
  args: { api: (() => {
    let declined = false;
    return accessFixtureApi({
      mine: async () => ({ ok: true, data: ownRequestFixture(declined ? 'declined' : 'pending') }),
      withdraw: async () => { declined = true; return { ok: false, failure: 'stale' }; },
    });
  })() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Withdraw request' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Plans changed.');
    await userEvent.click(dialog.getByRole('button', { name: 'Withdraw request' }));
    await expect(await canvas.findByText('Your request was declined.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Withdraw request' })).not.toBeInTheDocument();
  },
};
export const PendingEnglish: Story = { args: { locale: 'en', api: accessFixtureApi({}, ownRequestFixture('pending')) }, globals: { locale: 'en' } };
export const DeclinedEnglish: Story = { args: { locale: 'en', api: accessFixtureApi({}, ownRequestFixture('declined')) }, globals: { locale: 'en' } };
export const WithdrawnEnglish: Story = { args: { locale: 'en', api: accessFixtureApi({}, ownRequestFixture('withdrawn')) }, globals: { locale: 'en' } };
export const AcceptedEnglish: Story = { args: { locale: 'en', api: accessFixtureApi({}, ownRequestFixture('accepted')) }, globals: { locale: 'en' } };
export const SignedOutEnglish: Story = { args: { locale: 'en', actingSubject: null }, globals: { locale: 'en' } };
export const PendingTraditionalChinese: Story = { args: { locale: 'zh-Hant', api: accessFixtureApi({}, ownRequestFixture('pending')) }, globals: { locale: 'zh-Hant' } };
export const DeclinedTraditionalChinese: Story = { args: { locale: 'zh-Hant', api: accessFixtureApi({}, ownRequestFixture('declined')) }, globals: { locale: 'zh-Hant' } };
export const WithdrawnTraditionalChinese: Story = { args: { locale: 'zh-Hant', api: accessFixtureApi({}, ownRequestFixture('withdrawn')) }, globals: { locale: 'zh-Hant' } };
export const AcceptedTraditionalChinese: Story = { args: { locale: 'zh-Hant', api: accessFixtureApi({}, ownRequestFixture('accepted')) }, globals: { locale: 'zh-Hant' } };
export const SignedOutTraditionalChinese: Story = { args: { locale: 'zh-Hant', actingSubject: null,
  signInHref: signInPath('/zh-Hant/r/private-books') }, globals: { locale: 'zh-Hant' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: accessMessages['zh-Hant'].signIn })).toHaveAttribute('href', signInPath('/zh-Hant/r/private-books'));
    await expect(canvas.queryByRole('textbox')).not.toBeInTheDocument();
    await captureAccessStory('g-988-join-signed-out-zh-Hant');
  },
};
export const PendingSimplifiedChinese: Story = { args: { locale: 'zh-Hans', api: accessFixtureApi({}, ownRequestFixture('pending')) }, globals: { locale: 'zh-Hans' } };
export const DeclinedSimplifiedChinese: Story = { args: { locale: 'zh-Hans', api: accessFixtureApi({}, ownRequestFixture('declined')) }, globals: { locale: 'zh-Hans' } };
export const WithdrawnSimplifiedChinese: Story = { args: { locale: 'zh-Hans', api: accessFixtureApi({}, ownRequestFixture('withdrawn')) }, globals: { locale: 'zh-Hans' } };
export const AcceptedSimplifiedChinese: Story = { args: { locale: 'zh-Hans', api: accessFixtureApi({}, ownRequestFixture('accepted')) }, globals: { locale: 'zh-Hans' } };
export const SignedOutSimplifiedChinese: Story = { args: { locale: 'zh-Hans', actingSubject: null }, globals: { locale: 'zh-Hans' } };
export const PendingJapanese: Story = { args: { locale: 'ja', api: accessFixtureApi({}, ownRequestFixture('pending')) }, globals: { locale: 'ja' } };
export const DeclinedJapanese: Story = { args: { locale: 'ja', api: accessFixtureApi({}, ownRequestFixture('declined')) }, globals: { locale: 'ja' } };
export const WithdrawnJapanese: Story = { args: { locale: 'ja', api: accessFixtureApi({}, ownRequestFixture('withdrawn')) }, globals: { locale: 'ja' } };
export const AcceptedJapanese: Story = { args: { locale: 'ja', api: accessFixtureApi({}, ownRequestFixture('accepted')) }, globals: { locale: 'ja' } };
export const SignedOutJapanese: Story = { args: { locale: 'ja', actingSubject: null }, globals: { locale: 'ja' } };
export const PendingKorean: Story = { args: { locale: 'ko', api: accessFixtureApi({}, ownRequestFixture('pending')) }, globals: { locale: 'ko' } };
export const DeclinedKorean: Story = { args: { locale: 'ko', api: accessFixtureApi({}, ownRequestFixture('declined')) }, globals: { locale: 'ko' } };
export const WithdrawnKorean: Story = { args: { locale: 'ko', api: accessFixtureApi({}, ownRequestFixture('withdrawn')) }, globals: { locale: 'ko' } };
export const AcceptedKorean: Story = { args: { locale: 'ko', api: accessFixtureApi({}, ownRequestFixture('accepted')) }, globals: { locale: 'ko' } };
export const SignedOutKorean: Story = { args: { locale: 'ko', actingSubject: null }, globals: { locale: 'ko' } };
export const PendingGerman: Story = { args: { locale: 'de', api: accessFixtureApi({}, ownRequestFixture('pending')) }, globals: { locale: 'de' } };
export const DeclinedGerman: Story = { args: { locale: 'de', api: accessFixtureApi({}, ownRequestFixture('declined')) }, globals: { locale: 'de' } };
export const WithdrawnGerman: Story = { args: { locale: 'de', api: accessFixtureApi({}, ownRequestFixture('withdrawn')) }, globals: { locale: 'de' } };
export const AcceptedGerman: Story = { args: { locale: 'de', api: accessFixtureApi({}, ownRequestFixture('accepted')) }, globals: { locale: 'de' } };
export const SignedOutGerman: Story = { args: { locale: 'de', actingSubject: null }, globals: { locale: 'de' } };
export const PendingFrench: Story = { args: { locale: 'fr', api: accessFixtureApi({}, ownRequestFixture('pending')) }, globals: { locale: 'fr' } };
export const DeclinedFrench: Story = { args: { locale: 'fr', api: accessFixtureApi({}, ownRequestFixture('declined')) }, globals: { locale: 'fr' } };
export const WithdrawnFrench: Story = { args: { locale: 'fr', api: accessFixtureApi({}, ownRequestFixture('withdrawn')) }, globals: { locale: 'fr' } };
export const AcceptedFrench: Story = { args: { locale: 'fr', api: accessFixtureApi({}, ownRequestFixture('accepted')) }, globals: { locale: 'fr' } };
export const SignedOutFrench: Story = { args: { locale: 'fr', actingSubject: null }, globals: { locale: 'fr' } };
export const PendingSpanish: Story = { args: { locale: 'es', api: accessFixtureApi({}, ownRequestFixture('pending')) }, globals: { locale: 'es' } };
export const DeclinedSpanish: Story = { args: { locale: 'es', api: accessFixtureApi({}, ownRequestFixture('declined')) }, globals: { locale: 'es' } };
export const WithdrawnSpanish: Story = { args: { locale: 'es', api: accessFixtureApi({}, ownRequestFixture('withdrawn')) }, globals: { locale: 'es' } };
export const AcceptedSpanish: Story = { args: { locale: 'es', api: accessFixtureApi({}, ownRequestFixture('accepted')) }, globals: { locale: 'es' } };
export const SignedOutSpanish: Story = { args: { locale: 'es', actingSubject: null }, globals: { locale: 'es' } };

/** Browser journeys intercept the real BFF client; no separate route is mounted. */
export const BrowserRequest: Story = { name: 'Browser request', args: { api: undefined, persist: true },
  render: args => <PrivateSpaceJoinPage {...args} /> };

export const ChangedAdmissionRules: Story = {
  args: { api: accessFixtureApi({ request: async () => ({ ok: false, failure: 'stale' }) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('textbox'), 'I accept the rules.');
    await userEvent.click(canvas.getByRole('button', { name: 'Request to join' }));
    await expect(await canvas.findByText('The admission rules or your membership changed. Reload the community rules before trying again.')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Request to join' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Reload community rules' })).toBeVisible();
    await expect(canvas.getByRole('textbox')).toHaveValue('I accept the rules.');
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh request status' }));
    await expect(await canvas.findByRole('button', { name: 'Request to join' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Reload community rules' })).toBeVisible();
  },
};

export const RequestStatusUnavailable: Story = {
  args: { api: accessFixtureApi({ mine: async () => ({ ok: false, failure: 'unavailable' }) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Could not complete this. Try again.');
    await expect(canvas.queryByRole('button', { name: 'Request to join' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Refresh request status' })).toBeEnabled();
  },
};

export const RefreshRemoteDecision: Story = {
  args: { api: (() => {
    let reads = 0;
    return accessFixtureApi({ mine: async () => ({ ok: true, data: ownRequestFixture(reads++ === 0 ? 'pending' : 'declined') }) });
  })() },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Your request is pending. A manager will review it.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh request status' }));
    await expect(await canvas.findByText('Your request was declined.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Withdraw request' })).not.toBeInTheDocument();
  },
};
export const UnavailableReadDiscardsLegacyReceipt: Story = {
  args: { persist: true, api: accessFixtureApi({ mine: async () => ({ ok: false, failure: 'unavailable' }) }) },
  beforeEach() {
    const key = requestStorageKey(joinPageFixture.id, accessActor);
    const previous = localStorage.getItem(key);
    localStorage.setItem(key, JSON.stringify({ ...emptyRequestJournal(), receipt: {
      requestId: '00000000-0000-4000-8000-000000000021', requestGeneration: '0', state: 'pending' } }));
    return () => { if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous); };
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Could not complete this. Try again.');
    await expect(canvas.queryByText('Your request is pending. A manager will review it.')).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Withdraw request' })).not.toBeInTheDocument();
    await expect(JSON.parse(localStorage.getItem(requestStorageKey(joinPageFixture.id, accessActor)) ?? 'null')).not.toHaveProperty('receipt');
  },
};
