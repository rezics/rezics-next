import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { SettingsAccess } from './settings-access.tsx';
import { accessActor, accessFixtureApi, accessInitial, captureAccessStory } from './settings-fixtures.ts';
import { acting, header } from './fixtures.ts';
import { messages } from './messages.ts';
import { RealmFrame } from './realm-frame.tsx';

const meta = { title: 'Manage/Access settings', component: SettingsAccess,
  args: { initial: accessInitial, actingSubject: accessActor, locale: 'en', api: accessFixtureApi() },
  decorators: [Story => <div className="mx-auto max-w-5xl p-4 sm:p-8"><Story /></div>],
} satisfies Meta<typeof SettingsAccess>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = { async play() { await captureAccessStory('settings-en'); } };
export const TraditionalChinese: Story = { args: { locale: 'zh-Hant' }, globals: { locale: 'zh-Hant' } };
export const SimplifiedChinese: Story = { args: { locale: 'zh-Hans' }, globals: { locale: 'zh-Hans' } };
export const Japanese: Story = { args: { locale: 'ja' }, globals: { locale: 'ja' } };
export const Korean: Story = { args: { locale: 'ko' }, globals: { locale: 'ko' } };
export const German: Story = { args: { locale: 'de' }, globals: { locale: 'de' }, async play() { await captureAccessStory('settings-de'); } };
export const French: Story = { args: { locale: 'fr' }, globals: { locale: 'fr' } };
export const Spanish: Story = { args: { locale: 'es' }, globals: { locale: 'es' } };
export const ManagementFrame: Story = {
  render: args => <RealmFrame realm={args.initial.realm.slice(-36)} address={args.initial.space.slice(-36)}
    header={header} agent={acting} locale={args.locale} messages={messages}><SettingsAccess {...args} /></RealmFrame>,
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
    await waitFor(() => expect(dialog.getByText(/Only members can read/)).toBeVisible());
    await expect(dialog.getByText(/Non-member follows pause/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'A private reading group.');
    await captureAccessStory('settings-review');
    await userEvent.click(dialog.getByRole('button', { name: 'Save settings' }));
    await expect(await canvas.findByText('Settings saved.')).toBeVisible();
  },
};
export const ConcurrentChange: Story = {
  args: { api: accessFixtureApi({ save: async () => ({ ok: false, failure: 'stale' }),
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
