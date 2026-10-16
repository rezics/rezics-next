import type { Meta, StoryObj } from '@storybook/react-vite';
import { materializeData } from 'native-i18n';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/zone/withdraw-a-realm-attachment.json';
import { localizedPath } from '../../i18n/locale.ts';
import { spaceHref } from '../address/path.ts';
import { messages as editorMessages } from '../zone-editor/messages.ts';
import { messages } from './messages.ts';
import { ZoneAttachmentWithdrawalRecordedPage } from './zone-attachment-withdrawal-recorded-page.tsx';

const record = answers as AnswerRecord;
const copy = materializeData(messages, { locale: 'en' });
const editor = editorMessages.en;
const meta = {
  title: 'Manage/Recorded attachment withdrawal', component: ZoneAttachmentWithdrawalRecordedPage,
  args: { record, persona: 'owner', surface: 'realm', loading: false },
  globals: { viewport: { value: 'phone' }, locale: 'en' },
} satisfies Meta<typeof ZoneAttachmentWithdrawalRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function story(persona: NonNullable<Story['args']>['persona'], surface: 'realm' | 'delegated-realm' | 'zone' = 'realm',
  desktop = false, loading = false): Story {
  return { args: { persona, surface, loading }, globals: { viewport: { value: desktop ? 'desktop' : 'phone' } },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      if (loading) { await expect(canvas.findByRole('status')).resolves.toBeVisible(); return; }
      if (persona === 'visitor') {
        await expect(canvas.findByRole('status')).resolves.toHaveTextContent('/auth/start');
        await expect(canvas.queryByRole('button', { name: copy.zonesWithdraw })).toBeNull(); return;
      }
      const profile = record.personas[persona!].find(item => item.label === `${surface}-session-profile`)!.answer as { displayName: string };
      await expect(canvas.findByText(profile.displayName, { exact: true })).resolves.toBeVisible();
      if (surface === 'zone') {
        if (persona === 'member') {
          const sample = record.personas.member.find(item => item.label === 'attachment-name')!.answer as { name: { value: string } };
          await expect(canvas.findByText(sample.name.value, { exact: true })).resolves.toBeVisible();
          await userEvent.click(await canvas.findByRole('button', { name: editor.realmRemove }));
          await expect(canvas.findByText(editor.realmRemoved)).resolves.toBeVisible();
          await expect(canvas.getByText(editor.realmNone)).toBeVisible();
          await expect(canvas.queryByRole('button', { name: editor.realmRemove })).toBeNull();
        } else if (persona === 'operator') await expect(canvas.findByText(editor.realmNone)).resolves.toBeVisible();
        else await expect(canvas.findByText(editor.deniedTitle)).resolves.toBeVisible();
        return;
      }
      if (persona === 'owner' || persona === 'operator' || surface === 'delegated-realm') {
        const sample = record.personas[persona!].find(item => item.label === `${surface}-attachments`)!.answer as {
          items: { zone: string; name: string | null; address: { key: string } }[] };
        const target = record.personas[persona!].find(item => item.label === `${surface}-withdraw`)!.path.split('/')[3]!;
        const item = sample.items.find(row => row.zone.endsWith(target))!;
        const list = await canvas.findByRole('list', { name: copy.zonesTitle });
        const row = within(list).getAllByRole('listitem').find(node => within(node).queryByRole('link', {
          name: copy.zonesOpen({ zone: item.name ?? copy.zonesNameFallback }) }));
        if (!row) throw new Error('Recorded withdrawal target is absent');
        await expect(within(row).getByRole('link')).toHaveAttribute('href', localizedPath(spaceHref(item.address.key, 'site'), 'en'));
        await userEvent.click(within(row).getByRole('button', { name: copy.zonesWithdraw }));
        await expect(canvas.findByText(copy.zonesWithdrawn)).resolves.toBeVisible();
        await expect(row).not.toBeInTheDocument();
      } else {
        await expect(canvas.findByRole('heading', { name: copy.missingTitle })).resolves.toBeVisible();
        await expect(canvas.queryByRole('button', { name: copy.zonesWithdraw })).toBeNull();
      }
    } };
}

export const RealmOwnerPhone: Story = story('owner');
export const RealmOwnerDesktop: Story = story('owner', 'realm', true);
export const DelegatedStewardPhone: Story = story('moderator', 'delegated-realm');
export const DelegatedStewardDesktop: Story = story('moderator', 'delegated-realm', true);
export const ExactRealmMandate: Story = story('operator');
export const ZoneOwnerPhone: Story = story('member', 'zone');
export const ZoneOwnerDesktop: Story = story('member', 'zone', true);
export const ExactZoneMandateDetached: Story = story('operator', 'zone');
export const Stranger: Story = story('stranger');
export const Member: Story = story('member');
export const BareModerator: Story = story('moderator');
export const RealmOwnerWithoutZoneAuthority: Story = story('owner', 'zone');
export const StrangerZone: Story = story('stranger', 'zone');
export const ModeratorZone: Story = story('moderator', 'zone');
export const SignInRealm: Story = story('visitor');
export const SignInZone: Story = story('visitor', 'zone');
export const LoadingPhone: Story = story('owner', 'realm', false, true);
export const LoadingDesktop: Story = story('member', 'zone', true, true);
