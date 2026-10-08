import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { communityText } from '../communities/messages.ts';
import { SettingsAccess } from './settings-access.tsx';
import { accessActor, accessFixtureApi, accessInitial, captureAccessStory, realmAccessInitial } from './settings-fixtures.ts';
import { acting, header } from './fixtures.ts';
import { messages } from './messages.ts';
import { RealmFrame } from './realm-frame.tsx';

const restrictedRealm = { ...realmAccessInitial, settings: { ...realmAccessInitial.settings, visibility: 'restricted' as const,
  reviewRequired: true, reviewMode: 'mandatory' as const, selfJoin: false } };

const meta = { title: 'Manage/Access settings', component: SettingsAccess,
  args: { initial: accessInitial, realmSettings: realmAccessInitial, actingSubject: accessActor, locale: 'en', api: accessFixtureApi() },
  decorators: [Story => <div className="mx-auto max-w-5xl p-4 sm:p-8"><Story /></div>],
} satisfies Meta<typeof SettingsAccess>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = { async play({ canvasElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole('radio', { name: /^Public/ })).toBeChecked();
  await expect(canvas.getByRole('radio', { name: /^Restricted/ })).toBeVisible();
  await expect(canvas.getByText(communityText.publicHelp.en)).toBeVisible();
  await captureAccessStory('settings-en');
} };
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const Korean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' } };
export const German: Story = { args: { locale: 'de' }, globals: { locale: 'de' }, async play() { await captureAccessStory('settings-de'); } };
export const French: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' } };
export const Spanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' } };
/** A Realm created as restricted opens on that choice, with the create form's help. */
export const Restricted: Story = {
  args: { realmSettings: restrictedRealm },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('radio', { name: /^Restricted/ })).toBeChecked();
    await expect(canvas.getByText(communityText.restrictedHelp.en)).toBeVisible();
    await expect(canvas.getByRole('radio', { name: /^Public/ })).not.toBeChecked();
    await captureAccessStory('settings-restricted');
  },
};
export const ManagementFrame: Story = {
  render: args => <RealmFrame realm={args.initial.realm.slice(-36)} address={args.initial.space.slice(-36)}
    header={header} agent={acting} settingsAllowed={true} locale={args.locale} messages={messages}><SettingsAccess {...args} /></RealmFrame>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Join requests' })).toHaveAttribute('href',
      `/en/manage/r/${accessInitial.space.slice(-36)}/requests`);
    await captureAccessStory('manage-frame');
  },
};

export const ConsequencesBeforeSave: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /^Private/ }));
    await userEvent.click(canvas.getByRole('radio', { name: /^Unlisted/ }));
    await userEvent.click(canvas.getByRole('radio', { name: /^From admission/ }));
    await userEvent.click(canvas.getByRole('radio', { name: /^By invitation/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await waitFor(() => expect(dialog.getByText(communityText.privateHelp.en)).toBeVisible());
    await expect(dialog.getByText(/Non-member follows pause/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'A private reading group.');
    await captureAccessStory('settings-review');
    await userEvent.click(dialog.getByRole('button', { name: 'Save settings' }));
    await expect(await canvas.findByText('Settings saved.')).toBeVisible();
  },
};
export const ConcurrentChange: Story = {
  args: { api: accessFixtureApi({ saveRealm: async () => ({ ok: false, failure: 'stale' }),
    realm: async () => ({ ok: true, data: { ...realmAccessInitial, generation: '13' } }),
    settings: async () => ({ ok: true, data: { ...accessInitial, generation: '13', settings: { ...accessInitial.settings, listing: 'unlisted' } } }) }) },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('radio', { name: /^Private/ }));
    await userEvent.click(canvas.getByRole('button', { name: 'Review changes' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Restrict to members.');
    await userEvent.click(dialog.getByRole('button', { name: 'Save settings' }));
    await expect(await canvas.findByText(/Someone changed these settings/)).toBeVisible();
    await expect(canvas.getByRole('radio', { name: /^Private/ })).toBeChecked();
    await captureAccessStory('settings-conflict');
    await userEvent.click(canvas.getByRole('button', { name: 'Use current settings' }));
    await expect(canvas.getByRole('radio', { name: /^Public/ })).toBeChecked();
    await expect(canvas.getByRole('radio', { name: /^Unlisted/ })).toBeChecked();
  },
};
