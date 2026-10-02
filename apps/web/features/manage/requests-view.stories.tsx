import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RealmFrame } from './realm-frame.tsx';
import { acting, header } from './fixtures.ts';
import { messages } from './messages.ts';
import { accessMessages } from './settings-messages.ts';
import { RequestsView } from './requests-view.tsx';
import { accessActor, accessFixtureApi, accessInitial, captureAccessStory, requestsInitial, requestFixture } from './settings-fixtures.ts';

const meta = { title: 'Manage/Join requests', component: RequestsView,
  args: { initial: requestsInitial, space: accessInitial.space, realm: accessInitial.realm, actingSubject: accessActor,
    locale: 'en', api: accessFixtureApi() },
  decorators: [Story => <div className="mx-auto max-w-5xl p-4 sm:p-8"><Story /></div>],
} satisfies Meta<typeof RequestsView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = { async play() { await captureAccessStory('requests'); } };
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const Korean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' } };
export const German: Story = { args: { locale: 'de' }, globals: { locale: 'de' } };
export const French: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' } };
export const Spanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' } };
export const SearchAndContinue: Story = {
  args: { api: accessFixtureApi({ requests: async (cursor, q) => {
    await expect(q).toBe('Lin');
    if (!cursor) return { ok: true, data: { ...requestsInitial, nextCursor: 'searched-cursor', complete: false } };
    await expect(cursor).toBe('searched-cursor');
    return { ok: true, data: { generation: '12', items: [{ ...requestFixture,
      id: '00000000-0000-4000-8000-000000000022', reason: 'A matching request beyond the first page.' }], nextCursor: null, complete: true } };
  } }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox'), 'Lin');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Load more' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: 'Load more' }));
    await expect(await canvas.findByText('A matching request beyond the first page.')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  },
};
export const Approve: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Approve' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Welcome to the reading group.');
    await userEvent.click(dialog.getByRole('button', { name: 'Approve' }));
    await expect(await canvas.findByText('Member admitted.')).toBeVisible();
    await expect(canvas.queryByText(/I would like to discuss/)).not.toBeInTheDocument();
    await captureAccessStory('request-approved');
  },
};
export const StaleRequest: Story = {
  args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }) },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Approve' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Welcome.');
    await userEvent.click(dialog.getByRole('button', { name: 'Approve' }));
    await expect(await dialog.findByText(/The request or review basis changed/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await userEvent.click(dialog.getByRole('button', { name: 'Refresh requests' }));
    await expect(await within(canvasElement).findByText('A request on the next page.')).toBeVisible();
  },
};

export const RequestOnlyManager: Story = {
  render: args => <RealmFrame realm={args.realm.slice(-36)} header={header} agent={acting} locale={args.locale}
    messages={messages} settingsAllowed={false}><RequestsView {...args} /></RealmFrame>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Join requests' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Settings & rules' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Decline' })).toBeEnabled();
  },
};
export const Decline: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Decline' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'The group is at capacity.');
    await userEvent.click(dialog.getByRole('button', { name: 'Decline' }));
    await expect(await canvas.findByText('Request declined.')).toBeVisible();
  },
};
export const EmptyEnglish: Story = { args: { locale: 'en', initial: { generation: '12', items: [], nextCursor: null, complete: true } }, globals: { locale: 'en' } };
export const EmptyTraditionalChinese: Story = { args: { locale: 'zh-Hant', initial: { generation: '12', items: [], nextCursor: null, complete: true } }, globals: { locale: 'zh-Hant' } };
export const EmptySimplifiedChinese: Story = { args: { locale: 'zh-Hans', initial: { generation: '12', items: [], nextCursor: null, complete: true } }, globals: { locale: 'zh-Hans' } };
export const EmptyJapanese: Story = { args: { locale: 'ja', initial: { generation: '12', items: [], nextCursor: null, complete: true } }, globals: { locale: 'ja' } };
export const EmptyKorean: Story = { args: { locale: 'ko', initial: { generation: '12', items: [], nextCursor: null, complete: true } }, globals: { locale: 'ko' } };
export const EmptyGerman: Story = { args: { locale: 'de', initial: { generation: '12', items: [], nextCursor: null, complete: true } }, globals: { locale: 'de' } };
export const EmptyFrench: Story = { args: { locale: 'fr', initial: { generation: '12', items: [], nextCursor: null, complete: true } }, globals: { locale: 'fr' } };
export const EmptySpanish: Story = { args: { locale: 'es', initial: { generation: '12', items: [], nextCursor: null, complete: true } }, globals: { locale: 'es' } };

async function decideInLocale(canvasElement: HTMLElement, locale: keyof typeof accessMessages, decline: boolean) {
  const t = accessMessages[locale];
  const canvas = within(canvasElement);
  const label = decline ? t.decline : t.approve;
  await userEvent.click(canvas.getByRole('button', { name: label }));
  const dialog = within(await within(document.body).findByRole('dialog'));
  await userEvent.type(dialog.getByRole('textbox', { name: t.reason }), 'Decision reason.');
  await userEvent.click(dialog.getByRole('button', { name: label }));
}
export const ApprovedEnglish: Story = { args: { locale: 'en' }, globals: { locale: 'en' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'en', false);
    const t = accessMessages['en']; await expect(await within(canvasElement).findByText(t.approved)).toBeVisible(); } };
export const DeclinedEnglish: Story = { args: { locale: 'en' }, globals: { locale: 'en' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'en', true);
    const t = accessMessages['en']; await expect(await within(canvasElement).findByText(t.decisionDeclined)).toBeVisible(); } };
export const StaleEnglish: Story = { args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }), locale: 'en' }, globals: { locale: 'en' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'en', false);
    const t = accessMessages['en']; await expect(await within(await within(document.body).findByRole('dialog')).findByText(t.staleRequest)).toBeVisible(); } };
export const ApprovedTraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'zh-Hant', false);
    const t = accessMessages['zh-Hant']; await expect(await within(canvasElement).findByText(t.approved)).toBeVisible(); } };
export const DeclinedTraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'zh-Hant', true);
    const t = accessMessages['zh-Hant']; await expect(await within(canvasElement).findByText(t.decisionDeclined)).toBeVisible(); } };
export const StaleTraditionalChinese: Story = { args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }), locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'zh-Hant', false);
    const t = accessMessages['zh-Hant']; await expect(await within(await within(document.body).findByRole('dialog')).findByText(t.staleRequest)).toBeVisible(); } };
export const ApprovedSimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'zh-Hans', false);
    const t = accessMessages['zh-Hans']; await expect(await within(canvasElement).findByText(t.approved)).toBeVisible(); } };
export const DeclinedSimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'zh-Hans', true);
    const t = accessMessages['zh-Hans']; await expect(await within(canvasElement).findByText(t.decisionDeclined)).toBeVisible(); } };
export const StaleSimplifiedChinese: Story = { args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }), locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'zh-Hans', false);
    const t = accessMessages['zh-Hans']; await expect(await within(await within(document.body).findByRole('dialog')).findByText(t.staleRequest)).toBeVisible(); } };
export const ApprovedJapanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'ja', false);
    const t = accessMessages['ja']; await expect(await within(canvasElement).findByText(t.approved)).toBeVisible(); } };
export const DeclinedJapanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'ja', true);
    const t = accessMessages['ja']; await expect(await within(canvasElement).findByText(t.decisionDeclined)).toBeVisible(); } };
export const StaleJapanese: Story = { args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }), locale: 'ja' }, globals: { locale: 'ja' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'ja', false);
    const t = accessMessages['ja']; await expect(await within(await within(document.body).findByRole('dialog')).findByText(t.staleRequest)).toBeVisible(); } };
export const ApprovedKorean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'ko', false);
    const t = accessMessages['ko']; await expect(await within(canvasElement).findByText(t.approved)).toBeVisible(); } };
export const DeclinedKorean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'ko', true);
    const t = accessMessages['ko']; await expect(await within(canvasElement).findByText(t.decisionDeclined)).toBeVisible(); } };
export const StaleKorean: Story = { args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }), locale: 'ko' }, globals: { locale: 'ko' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'ko', false);
    const t = accessMessages['ko']; await expect(await within(await within(document.body).findByRole('dialog')).findByText(t.staleRequest)).toBeVisible(); } };
export const ApprovedGerman: Story = { args: { locale: 'de' }, globals: { locale: 'de' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'de', false);
    const t = accessMessages['de']; await expect(await within(canvasElement).findByText(t.approved)).toBeVisible(); } };
export const DeclinedGerman: Story = { args: { locale: 'de' }, globals: { locale: 'de' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'de', true);
    const t = accessMessages['de']; await expect(await within(canvasElement).findByText(t.decisionDeclined)).toBeVisible(); } };
export const StaleGerman: Story = { args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }), locale: 'de' }, globals: { locale: 'de' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'de', false);
    const t = accessMessages['de']; await expect(await within(await within(document.body).findByRole('dialog')).findByText(t.staleRequest)).toBeVisible(); } };
export const ApprovedFrench: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'fr', false);
    const t = accessMessages['fr']; await expect(await within(canvasElement).findByText(t.approved)).toBeVisible(); } };
export const DeclinedFrench: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'fr', true);
    const t = accessMessages['fr']; await expect(await within(canvasElement).findByText(t.decisionDeclined)).toBeVisible(); } };
export const StaleFrench: Story = { args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }), locale: 'fr' }, globals: { locale: 'fr' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'fr', false);
    const t = accessMessages['fr']; await expect(await within(await within(document.body).findByRole('dialog')).findByText(t.staleRequest)).toBeVisible(); } };
export const ApprovedSpanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'es', false);
    const t = accessMessages['es']; await expect(await within(canvasElement).findByText(t.approved)).toBeVisible(); } };
export const DeclinedSpanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'es', true);
    const t = accessMessages['es']; await expect(await within(canvasElement).findByText(t.decisionDeclined)).toBeVisible(); } };
export const StaleSpanish: Story = { args: { api: accessFixtureApi({ decide: async () => ({ ok: false, failure: 'stale' }) }), locale: 'es' }, globals: { locale: 'es' },
  async play({ canvasElement }) { await decideInLocale(canvasElement, 'es', false);
    const t = accessMessages['es']; await expect(await within(await within(document.body).findByRole('dialog')).findByText(t.staleRequest)).toBeVisible(); } };

export const BrowserInbox: Story = { name: 'Browser inbox', args: { api: undefined } };

export const BrowserRequestOnlyManager: Story = {
  name: 'Browser request-only manager',
  render: args => <RealmFrame realm={args.realm.slice(-36)} header={header} agent={{ ...acting, iri: args.actingSubject }}
    locale={args.locale} messages={messages}><RequestsView {...args} /></RealmFrame>,
};

export const StaleContinuation: Story = {
  args: { api: accessFixtureApi({ requests: async cursor => cursor ? { ok: false, failure: 'stale' }
    : { ok: true, data: { ...requestsInitial, nextCursor: null, complete: true } } }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Load more' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('The request or review basis changed. Refresh the list before deciding.');
    await expect(canvas.getByRole('button', { name: 'Load more' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Refresh requests' }));
    await waitFor(() => expect(canvas.queryByRole('alert')).not.toBeInTheDocument());
    await expect(canvas.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  },
};
