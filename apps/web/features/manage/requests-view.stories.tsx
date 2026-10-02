import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RequestsView } from './requests-view.tsx';
import { accessActor, accessFixtureApi, accessInitial, captureAccessStory, requestsInitial } from './settings-fixtures.ts';

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
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox'), 'next page');
    await expect(canvas.getByText('No loaded requests match your search.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Load more' }));
    await expect(await canvas.findByText('A request on the next page.')).toBeVisible();
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
export const ExpiredRequest: Story = {
  args: { api: accessFixtureApi({ approve: async () => ({ ok: false, failure: 'stale' }) }) },
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Approve' }));
    const dialog = within(await within(document.body).findByRole('dialog'));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Welcome.');
    await userEvent.click(dialog.getByRole('button', { name: 'Approve' }));
    await expect(await dialog.findByText(/This request changed or expired/)).toBeVisible();
    await userEvent.click(dialog.getByRole('button', { name: 'Refresh requests' }));
    await expect(await within(canvasElement).findByText('A request on the next page.')).toBeVisible();
  },
};
