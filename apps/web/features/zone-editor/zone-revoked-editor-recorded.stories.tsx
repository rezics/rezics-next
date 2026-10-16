import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import answers from '../../../../tests/qa/fixtures/outcomes/zone/publish-after-editor-revocation-revoked-editors.json';
import { localizedPath } from '../../i18n/locale.ts';
import { profileHref } from '../profile/route.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { materializeData } from 'native-i18n';
import { agentShort } from '../manage/format.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { creditText } from '../zones/credit-messages.ts';
import { messages } from './messages.ts';
import { ZoneRevokedEditorRecordedPage } from './zone-revoked-editor-recorded-page.tsx';

const record = answers as AnswerRecord;
const meta = { title: 'Zone/Revoked editor recorded', component: ZoneRevokedEditorRecordedPage,
  args: { record, persona: 'owner' }, globals: { locale: 'en' } } satisfies Meta<typeof ZoneRevokedEditorRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;
function story(persona: AnswerPersona, prefix: string, view: 'editor' | 'preview' | 'public' = 'editor',
  viewport = 'phone', loading = false, stale = false): Story {
  return { args: { persona, prefix, view, loading, stale }, globals: { viewport: { value: viewport } },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      if (loading) { await expect(canvas.findByRole('status', { name: shellMessages.loading })).resolves.toBeVisible(); return; }
      if (persona === 'visitor' && view !== 'public') {
        await expect(canvas.findByRole('status')).resolves.toHaveTextContent('/auth/start'); return;
      }
      if (view === 'public') {
        await expect(canvas.findByText('Previous public original garden')).resolves.toBeVisible();
        await expect(canvas.queryByText('Persistently saved private original garden')).toBeNull();
        await expect(canvas.queryByRole('link', { name: manageMessages.editSite })).toBeNull();
        const presentation = record.personas[persona].find(s => s.label === `${prefix}-presentation`)!.answer as {
          home: { reference: { provenance: { author: string } } };
        };
        await expect(canvas.getByRole('link', { name: creditText.en.contributor })).toHaveAttribute('href',
          localizedPath(profileHref({ handle: null, id: presentation.home.reference.provenance.author }), 'en'));
        await expect(canvas.getByText(creditText.en.original)).toBeVisible(); return;
      }
      if (prefix.startsWith('revoked')) {
        await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(messages.en.deniedTitle);
        await expect(canvas.queryByRole('button', { name: messages.en.publish })).toBeNull();
        await expect(canvas.queryByText('Persistently saved private original garden')).toBeNull(); return;
      }
      const text = persona === 'member' || persona === 'moderator' ? `Original garden saved by the ${persona} controller`
        : 'Persistently saved private original garden';
      await expect(canvas.findByText(text)).resolves.toBeVisible();
      const editor = record.personas[persona].find(s => s.label === `${prefix}-editor`)!;
      const acting = new URL(editor.path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
      await expect(canvas.getByText(materializeData(manageMessages, { locale: 'en' }).agentFallback({ id: agentShort(acting) }), { exact: true })).toBeVisible();
      if (stale) {
        await userEvent.click(await canvas.findByRole('button', { name: messages.en.publish }));
        await expect(canvas.findByRole('alert')).resolves.toHaveTextContent('Zone head changed');
        await expect(canvas.getByRole('alert')).toHaveTextContent('stale_zone_head');
        await expect(canvas.getByRole('button', { name: messages.en.publish })).toBeDisabled();
        await expect(canvas.getByText(text)).toBeVisible();
      }
    } };
}
export const RevokedMemberPhone = story('member', 'revoked');
export const RevokedMemberDesktop = story('member', 'revoked', 'editor', 'desktop');
export const RevokedModeratorPhone = story('moderator', 'revoked', 'preview');
export const RevokedModeratorDesktop = story('moderator', 'revoked', 'preview', 'desktop');
export const RevokedOwnerPhone = story('owner', 'revoked');
export const RevokedOwnerDesktop = story('owner', 'revoked', 'editor', 'desktop');
export const RevokedOperatorPhone = story('operator', 'revoked-1', 'preview');
export const RevokedOperatorDesktop = story('operator', 'revoked-1', 'preview', 'desktop');
export const StrangerPhone = story('stranger', 'revoked-1');
export const StrangerDesktop = story('stranger', 'revoked-1', 'editor', 'desktop');
export const RestoredMemberPhone = story('member', 'restored', 'preview');
export const RestoredMemberDesktop = story('member', 'restored', 'preview', 'desktop');
export const RestoredModeratorPhone = story('moderator', 'restored');
export const RestoredModeratorDesktop = story('moderator', 'restored', 'editor', 'desktop');
export const RestoredOwnerPhone = story('owner', 'restored');
export const RestoredOwnerDesktop = story('owner', 'restored', 'editor', 'desktop');
export const RestoredOperatorPhone = story('operator', 'restored', 'preview');
export const RestoredOperatorDesktop = story('operator', 'restored', 'preview', 'desktop');
export const PriorPublicPhone = story('visitor', 'prior', 'public');
export const PriorPublicDesktop = story('visitor', 'prior', 'public', 'desktop');
export const RevokedPublicPhone = story('member', 'prior', 'public');
export const RevokedPublicDesktop = story('member', 'prior', 'public', 'desktop');
export const StalePhone = story('owner', 'stale', 'editor', 'phone', false, true);
export const StaleDesktop = story('owner', 'stale', 'editor', 'desktop', false, true);
export const LoadingPhone = story('owner', 'restored', 'editor', 'phone', true);
export const LoadingDesktop = story('owner', 'restored', 'editor', 'desktop', true);
export const SignInPhone = story('visitor', 'management');
export const SignInDesktop = story('visitor', 'management', 'editor', 'desktop');
