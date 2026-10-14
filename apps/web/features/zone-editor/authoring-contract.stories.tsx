import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { ZoneAuthoringContractPage } from './authoring-contract-page.tsx';
import { authoringContractRequests, contractActor, contractManagementKey, contractZoneId, type AuthoringContractState } from './authoring-contract.fixtures.ts';
import { zoneEditorDraftKey } from './draft-state.ts';
import { messages } from './messages.ts';

const meta = {
  title: 'Zone editor/Contract authoring states', component: ZoneAuthoringContractPage,
  args: { state: 'saved', view: 'manage', locale: 'en' },
  render: (args, { globals }) => <ZoneAuthoringContractPage key={`${args.state}-${args.view}-${globals.locale ?? args.locale}`}
    {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />,
  beforeEach({ args }) {
    for (const section of ['home', 'navigation', 'theme', 'attachment', 'lifecycle'] as const) {
      sessionStorage.removeItem(zoneEditorDraftKey(contractZoneId, contractActor(args.state), section));
    }
  },
  parameters: { route: { pathname: `/en/manage/z/${contractZoneId}` },
    docs: { description: { component: 'Contract-built states awaiting recording. The exact request/state inventory is authoringContractRequests(state). These are not captured API answers.' } } },
} satisfies Meta<typeof ZoneAuthoringContractPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function scenario(state: AuthoringContractState, viewport: 'phone' | 'desktop', view: 'manage' | 'preview' = 'manage'): Story {
  return { args: { state, view }, globals: { viewport: { value: viewport } },
    parameters: { contractState: authoringContractRequests(state),
      route: { pathname: `/en/manage/z/${contractManagementKey(state)}${view === 'preview' ? '/preview' : state === 'retired' ? '/lifecycle' : ''}` } },
    async play({ canvasElement, globals }) {
      const canvas = within(canvasElement);
      const copy = messages[(globals.locale as UiLocale | undefined) ?? 'en'];
      if (state === 'loading') { await expect(await canvas.findByRole('status')).toBeVisible(); return; }
      if (state.startsWith('revoked-') || state === 'operator-without-agent') {
        await expect(await canvas.findByRole('heading', { name: copy.deniedTitle })).toBeVisible();
        await expect(canvas.queryByRole('textbox', { name: copy.editorLabel })).toBeNull();
        await expect(canvas.queryByText('Saved by the original Agent. 雨夜の庭。')).toBeNull();
        return;
      }
      if (state === 'unavailable') { await expect(await canvas.findByRole('heading', { name: copy.unavailableTitle })).toBeVisible(); return; }
      if (view === 'preview') {
        await expect(await canvas.findByText('Saved by the original Agent. 雨夜の庭。')).toBeVisible();
        await expect(canvas.getByRole('heading', { name: copy.previewTitle })).toBeVisible();
      } else if (state === 'retired') {
        await expect(await canvas.findByRole('button', { name: copy.lifecycleRecover })).toBeVisible();
        await expect(canvas.queryByRole('link', { name: copy.sectionHome })).toBeNull();
      } else {
        await expect(await canvas.findByRole('textbox', { name: copy.editorLabel })).toBeVisible();
        if (state === 'pending-save' || state === 'pending-publication') {
          await userEvent.click(canvas.getByRole('button', { name: state === 'pending-save' ? copy.save : copy.publish }));
          await expect(await canvas.findByText(copy.commandPending)).toBeVisible();
          await expect(canvas.queryByText(copy.unavailableBody)).toBeNull();
          await userEvent.click(canvas.getByRole('button', { name: copy.checkConfirmation }));
          await expect(await canvas.findByText(state === 'pending-save' ? copy.savedReplayed : copy.publishedReplayed)).toBeVisible();
        }
        if (state === 'replayed-after-competition') {
          await userEvent.click(canvas.getByRole('button', { name: copy.publish }));
          await expect(await canvas.findByText(copy.publishedReplayed)).toBeVisible();
          await expect(canvas.getByText(copy.statusBehind)).toBeVisible();
          await userEvent.click(canvas.getByText(copy.receiptTitle, { selector: 'summary' }));
          await expect(canvas.getByRole('heading', { name: `${copy.receiptPages} (1)` })).toBeVisible();
        }
      }
      await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    } };
}

export const SavedPhone: Story = scenario('saved', 'phone');
export const SavedDesktop: Story = scenario('saved', 'desktop');
export const LoadingPhone: Story = scenario('loading', 'phone');
export const LoadingDesktop: Story = scenario('loading', 'desktop');
export const EmptyPhone: Story = scenario('empty', 'phone');
export const EmptyDesktop: Story = scenario('empty', 'desktop');
export const UnavailablePhone: Story = scenario('unavailable', 'phone');
export const UnavailableDesktop: Story = scenario('unavailable', 'desktop');
export const RetiredRecoveryPhone: Story = scenario('retired', 'phone');
export const RetiredRecoveryDesktop: Story = scenario('retired', 'desktop');
export const RetiredSavedPreviewPhone: Story = scenario('retired', 'phone', 'preview');
export const RetiredSavedPreviewDesktop: Story = scenario('retired', 'desktop', 'preview');
export const RecoveredSavedPreviewPhone: Story = scenario('recovered', 'phone', 'preview');
export const RecoveredSavedPreviewDesktop: Story = scenario('recovered', 'desktop', 'preview');
export const RevokedMemberPhone: Story = scenario('revoked-member', 'phone');
export const RevokedMemberDesktop: Story = scenario('revoked-member', 'desktop');
export const RevokedModeratorPhone: Story = scenario('revoked-moderator', 'phone', 'preview');
export const RevokedModeratorDesktop: Story = scenario('revoked-moderator', 'desktop', 'preview');
export const RestoredPhone: Story = scenario('restored', 'phone');
export const RestoredDesktop: Story = scenario('restored', 'desktop');
export const OperatorWithoutAgentPhone: Story = scenario('operator-without-agent', 'phone');
export const OperatorWithoutAgentDesktop: Story = scenario('operator-without-agent', 'desktop');
export const OperatorMandatePhone: Story = scenario('operator-mandate', 'phone');
export const OperatorMandateDesktop: Story = scenario('operator-mandate', 'desktop');
export const PendingSavePhone: Story = scenario('pending-save', 'phone');
export const PendingSaveDesktop: Story = scenario('pending-save', 'desktop');
export const PendingPublicationPhone: Story = scenario('pending-publication', 'phone');
export const PendingPublicationDesktop: Story = scenario('pending-publication', 'desktop');
export const OriginalReceiptAfterCompetitionPhone: Story = scenario('replayed-after-competition', 'phone');
export const OriginalReceiptAfterCompetitionDesktop: Story = scenario('replayed-after-competition', 'desktop');
