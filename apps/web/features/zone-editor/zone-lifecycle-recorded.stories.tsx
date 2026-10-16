import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import lifecycle from '../../../../tests/qa/fixtures/outcomes/zone/lifecycle.json';
import { creditText } from '../zones/credit-messages.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { profileHref } from '../profile/route.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { messages as editorMessages } from './messages.ts';
const messages = editorMessages.en;
import { ZoneLifecycleRecordedPage } from './zone-lifecycle-recorded-page.tsx';

const record = lifecycle as AnswerRecord;
const meta = { title: 'Zone/Lifecycle recorded', component: ZoneLifecycleRecordedPage,
  args: { record, persona: 'owner' }, globals: { locale: 'en' } } satisfies Meta<typeof ZoneLifecycleRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;
function story(persona: AnswerPersona,
  options: { prefix?: string; preview?: boolean; publicPage?: boolean; loading?: boolean; stale?: boolean; command?: boolean } = {},
  viewport = 'phone'): Story {
  const { command, ...args } = options;
  return { args: { persona, ...args }, globals: { viewport: { value: viewport } }, play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    if (options.loading) { await expect(canvas.findByRole('status', { name: shellMessages.loading })).resolves.toBeVisible(); return; }
    if (persona === 'visitor' && !options.publicPage) {
      await expect(canvas.findByRole('status')).resolves.toHaveTextContent('/auth/start');
      await expect(canvas.queryByRole('button', { name: messages.lifecycleRetire })).toBeNull(); return;
    }
    if (options.publicPage) {
      await expect(canvas.findByText('Retained original garden')).resolves.toBeVisible();
      await expect(canvas.queryByText('Private retained later garden')).toBeNull();
      const answer = record.personas[persona].find(s => s.label === `${options.prefix}-presentation`)!.answer as {
        home: { reference: { revisionId: string; provenance: { author: string } } };
      };
      await expect(canvas.getByRole('link', { name: creditText.en.contributor })).toHaveAttribute('href',
        localizedPath(profileHref({ handle: null, id: answer.home.reference.provenance.author }), 'en'));
      await expect(canvas.getByText(creditText.en.original)).toBeVisible(); return;
    }
    if (persona !== 'owner' && persona !== 'operator') {
      await expect(canvas.findByRole('alert')).resolves.toBeVisible();
      await expect(canvas.getByText(messages.deniedBody)).toBeVisible();
      await expect(canvas.queryByRole('button', { name: messages.lifecycleRetire })).toBeNull();
      await expect(canvas.queryByText('Private retained later garden')).toBeNull(); return;
    }
    if (options.preview) {
      await expect(canvas.findByText('Private retained later garden')).resolves.toBeVisible();
      await expect(canvas.queryByText('Retained original garden')).toBeNull(); return;
    }
    const prefix = options.prefix ?? 'lifecycle';
    const saved = record.personas[persona].find(s => s.label === `${prefix}-binding-configuration`)!.answer as { revision: string };
    await expect(canvas.findByText(saved.revision)).resolves.toBeVisible();
    const action = prefix === 'retired' ? messages.lifecycleRecover : messages.lifecycleRetire;
    await expect(canvas.findByRole('button', { name: action })).resolves.toBeVisible();
    if (command) {
      await userEvent.click(canvas.getByRole('button', { name: action }));
      await userEvent.click(canvas.getByRole('button', { name: messages.lifecycleConfirmAction }));
      await expect(canvas.findByText(options.stale ? messages.lifecycleStaleTitle : prefix === 'retired'
        ? messages.lifecycleRecoveredSaved : messages.lifecycleRetiredSaved)).resolves.toBeVisible();
      if (options.stale) await expect(canvas.getByRole('button', { name: messages.lifecycleConfirmAction })).toBeDisabled();
    }
  } };
}
export const RetireOwnerPhone: Story = story('owner', { command: true });
export const RetireOwnerDesktop: Story = story('owner', { command: true }, 'desktop');
export const RecoverOwnerPhone: Story = story('owner', { prefix: 'retired', command: true });
export const RecoverOwnerDesktop: Story = story('owner', { prefix: 'retired', command: true }, 'desktop');
export const MandatedOperatorPhone: Story = story('operator', { command: true });
export const MandatedOperatorDesktop: Story = story('operator', { command: true }, 'desktop');
export const StalePhone: Story = story('owner', { stale: true, command: true });
export const StaleDesktop: Story = story('owner', { stale: true, command: true }, 'desktop');
export const LoadingPhone: Story = story('owner', { loading: true });
export const LoadingDesktop: Story = story('owner', { loading: true }, 'desktop');
export const PreviewPhone: Story = story('owner', { preview: true });
export const PreviewDesktop: Story = story('owner', { preview: true }, 'desktop');
export const RecoveredPreviewPhone: Story = story('operator', { prefix: 'recovered', preview: true });
export const RecoveredPreviewDesktop: Story = story('operator', { prefix: 'recovered', preview: true }, 'desktop');
export const PublicVisitorPhone: Story = story('visitor', { prefix: 'public', publicPage: true });
export const PublicVisitorDesktop: Story = story('visitor', { prefix: 'public', publicPage: true }, 'desktop');
export const RecoveredPublicPhone: Story = story('owner', { prefix: 'recovered-public', publicPage: true });
export const RecoveredPublicDesktop: Story = story('owner', { prefix: 'recovered-public', publicPage: true }, 'desktop');
export const StrangerPhone: Story = story('stranger');
export const StrangerDesktop: Story = story('stranger', {}, 'desktop');
export const MemberPhone: Story = story('member');
export const MemberDesktop: Story = story('member', {}, 'desktop');
export const ModeratorPhone: Story = story('moderator');
export const ModeratorDesktop: Story = story('moderator', {}, 'desktop');
export const SignInPhone: Story = story('visitor');
export const SignInDesktop: Story = story('visitor', {}, 'desktop');
