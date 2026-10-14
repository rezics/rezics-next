import { documentText, type DocumentSnapshot } from '@rezics/document';
import type { CanonicalAddress } from '@rezics/model/address';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import independentZone from '../../../../tests/qa/fixtures/outcomes/zone/a-zone-without-a-realm.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { surfaceText } from '../address/messages.ts';
import { addressKey } from '../address/path.ts';
import { signInPath } from '../auth/paths.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages as editorMessages } from '../zone-editor/messages.ts';
import { zoneEditorPath } from '../zone-editor/routes.ts';
import { zoneHomeDocument } from '../zone-editor/home-document.tsx';
import { IndependentZoneRecordedManagement, type IndependentZoneManagementPlace } from './independent-zone-recorded-page-manage.tsx';
import { IndependentZoneRecordedPage } from './independent-zone-recorded-page.tsx';
import { zoneSitePrefix } from './zone-site-recorded-page.ts';

const record = independentZone as AnswerRecord;
const personas = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'] as const satisfies readonly AnswerPersona[];

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing ${persona} sample ${label}`);
  return found;
}

function visit(persona: AnswerPersona, presentation: 'populated' | 'loading'): readonly RecordedSelection[] {
  const editor = record.personas[persona].find(item => item.label === 'page-editor-link');
  return [
    { label: 'page-address', state: 'populated' },
    { label: 'page-presentation', state: presentation },
    ...(editor ? [{ label: 'page-editor-link', state: editor.status === 200 ? 'populated' as const : 'error' as const }] : []),
  ];
}

const populatedSelections = Object.fromEntries(personas.map(persona => [persona, visit(persona, 'populated')])) as Record<
  AnswerPersona, readonly RecordedSelection[]>;
const loadingSelections = Object.fromEntries(personas.map(persona => [persona, visit(persona, 'loading')])) as Record<
  AnswerPersona, readonly RecordedSelection[]>;

function presentation(persona: AnswerPersona) {
  return sample(persona, 'page-presentation').answer as {
    name: string;
    home: { reference?: { provenance?: { rightsBasis?: unknown; author?: unknown } } };
  };
}

function homeText(persona: AnswerPersona): string {
  const document = zoneHomeDocument(presentation(persona).home);
  if (!document) throw new Error(`${persona} presentation has no home document`);
  return documentText(document);
}

function credit(persona: AnswerPersona): { rightsBasis: string; author: string } {
  const provenance = presentation(persona).home.reference?.provenance;
  if (typeof provenance?.rightsBasis !== 'string' || typeof provenance.author !== 'string') {
    throw new Error(`${persona} presentation has no credit`);
  }
  return { rightsBasis: provenance.rightsBasis, author: provenance.author };
}

function canonical(persona: AnswerPersona): CanonicalAddress {
  const address = (sample(persona, 'page-address').answer as { canonical?: { prefix?: unknown; key?: unknown; suffixSource?: unknown } }).canonical;
  if (!address || address.prefix !== zoneSitePrefix || typeof address.key !== 'string' || typeof address.suffixSource !== 'string') {
    throw new Error(`${persona} address has no site canonical`);
  }
  return { prefix: zoneSitePrefix, key: address.key, suffixSource: address.suffixSource };
}

const meta = {
  title: 'Zones/Independent Zone recorded',
  component: IndependentZoneRecordedPage,
  args: { record, persona: 'visitor' as const, selections: populatedSelections.visitor, locale: 'en' as const },
  render: (args, { globals }) => (
    <IndependentZoneRecordedPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof IndependentZoneRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function populatedPlay(persona: AnswerPersona) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const shown = credit(persona);
    const editor = record.personas[persona].find(item => item.label === 'page-editor-link');
    await expect(canvas.findByRole('heading', { level: 1, name: presentation(persona).name })).resolves.toBeVisible();
    await expect(canvas.getByText(homeText(persona))).toBeVisible();
    await expect(canvas.getByText(shown.rightsBasis)).toBeVisible();
    await expect(canvas.getByText(shown.author)).toBeVisible();
    await expect(canvas.getByRole('link', { name: realmMessages.home })).toBeVisible();
    const edit = canvas.queryByRole('link', { name: manageMessages.editSite });
    if (editor?.status === 200) {
      await expect(edit).toHaveAttribute('href', localizedPath(zoneEditorPath(addressKey(canonical(persona))), 'en'));
    } else {
      await expect(edit).toBeNull();
    }
  };
}

function loadingPlay(persona: AnswerPersona) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
    await expect(canvas.queryByText(homeText(persona))).toBeNull();
    await expect(canvas.queryByRole('link', { name: manageMessages.editSite })).toBeNull();
  };
}

function at(persona: AnswerPersona, state: 'populated' | 'loading', viewport: 'phone' | 'desktop'): Story {
  return {
    args: { persona, selections: state === 'populated' ? populatedSelections[persona] : loadingSelections[persona] },
    globals: { viewport: { value: viewport } },
    play: state === 'populated' ? populatedPlay(persona) : loadingPlay(persona),
  };
}

export const PopulatedVisitorPhone: Story = at('visitor', 'populated', 'phone');
export const PopulatedVisitorDesktop: Story = at('visitor', 'populated', 'desktop');
export const PopulatedStrangerPhone: Story = at('stranger', 'populated', 'phone');
export const PopulatedStrangerDesktop: Story = at('stranger', 'populated', 'desktop');
export const PopulatedMemberPhone: Story = at('member', 'populated', 'phone');
export const PopulatedMemberDesktop: Story = at('member', 'populated', 'desktop');
export const PopulatedOwnerPhone: Story = at('owner', 'populated', 'phone');
export const PopulatedOwnerDesktop: Story = at('owner', 'populated', 'desktop');
export const PopulatedModeratorPhone: Story = at('moderator', 'populated', 'phone');
export const PopulatedModeratorDesktop: Story = at('moderator', 'populated', 'desktop');
export const PopulatedOperatorPhone: Story = at('operator', 'populated', 'phone');
export const PopulatedOperatorDesktop: Story = at('operator', 'populated', 'desktop');
export const LoadingVisitorPhone: Story = at('visitor', 'loading', 'phone');
export const LoadingVisitorDesktop: Story = at('visitor', 'loading', 'desktop');
export const LoadingStrangerPhone: Story = at('stranger', 'loading', 'phone');
export const LoadingStrangerDesktop: Story = at('stranger', 'loading', 'desktop');
export const LoadingMemberPhone: Story = at('member', 'loading', 'phone');
export const LoadingMemberDesktop: Story = at('member', 'loading', 'desktop');
export const LoadingOwnerPhone: Story = at('owner', 'loading', 'phone');
export const LoadingOwnerDesktop: Story = at('owner', 'loading', 'desktop');
export const LoadingModeratorPhone: Story = at('moderator', 'loading', 'phone');
export const LoadingModeratorDesktop: Story = at('moderator', 'loading', 'desktop');
export const LoadingOperatorPhone: Story = at('operator', 'loading', 'phone');
export const LoadingOperatorDesktop: Story = at('operator', 'loading', 'desktop');

const editorCopy = editorMessages.en;
type ManagedPersona = 'stranger' | 'member' | 'owner' | 'moderator' | 'operator';
type EditorPersona = 'owner' | 'operator';

function recordedSpace(persona: AnswerPersona): string {
  const key = new URL(sample(persona, 'page-address').path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error(`${persona} address has no space`);
  return key;
}

function actingName(persona: ManagedPersona): string {
  const label = (sample(persona, 'page-agent-profile').answer as { displayName?: unknown }).displayName;
  if (typeof label !== 'string' || !label) throw new Error(`${persona} has no recorded acting name`);
  return label;
}

function zoneTitle(persona: EditorPersona, label: 'management-zone' | 'saved-preview-zone'): string {
  const name = (sample(persona, label).answer as { name?: unknown }).name;
  if (typeof name !== 'string' || !name) throw new Error(`${label} has no name`);
  return name;
}

function recordedDocument(persona: EditorPersona, label: string): string {
  const item = sample(persona, label);
  const answer = item.answer as { draft?: { document?: DocumentSnapshot } } | null;
  const body = item.body as { document?: DocumentSnapshot } | null;
  const document = answer?.draft?.document ?? body?.document;
  if (!document) throw new Error(`${label} has no document`);
  return documentText(document);
}

function managementStory(persona: AnswerPersona, place: IndependentZoneManagementPlace, viewport: 'phone' | 'desktop',
  play: Story['play']): Story {
  return {
    render: () => <IndependentZoneRecordedManagement record={record} persona={persona} place={place} locale="en" />,
    globals: { viewport: { value: viewport }, locale: 'en' },
    play,
  };
}

function redirectPlay(): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const target = signInPath(localizedPath(zoneEditorPath(recordedSpace('visitor')), 'en'));
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(target);
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.queryByRole('region', { name: manageMessages.actingAs })).toBeNull();
  };
}

function deniedPlay(persona: ManagedPersona): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('heading', { level: 1, name: recordedSpace(persona) })).resolves.toBeVisible();
    await expect(canvas.findByRole('alert')).resolves.toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: editorCopy.deniedTitle })).toBeVisible();
    await expect(canvas.getByText(editorCopy.deniedBody)).toBeVisible();
    const acting = within(canvas.getByRole('region', { name: manageMessages.actingAs }));
    await expect(acting.getByText(actingName(persona))).toBeVisible();
    await expect(canvas.queryByRole('button', { name: editorCopy.save })).toBeNull();
    await expect(canvas.queryByRole('heading', { name: editorCopy.previewTitle })).toBeNull();
  };
}

function editorManagePlay(persona: EditorPersona): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('heading', { level: 1, name: zoneTitle(persona, 'management-zone') })).resolves.toBeVisible();
    const acting = within(canvas.getByRole('region', { name: manageMessages.actingAs }));
    await expect(acting.getByText(actingName(persona))).toBeVisible();
    await expect(canvas.findByText(recordedDocument(persona, 'management-editor'))).resolves.toBeVisible();
    await expect(canvas.getByRole('button', { name: editorCopy.save })).toBeVisible();
    await expect(canvas.queryByRole('alert')).toBeNull();
  };
}

function editorPreviewPlay(persona: EditorPersona): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = zoneTitle(persona, 'saved-preview-zone');
    await expect(canvas.findAllByRole('heading', { level: 1, name: title })).resolves.toHaveLength(2);
    await expect(canvas.getByRole('heading', { level: 2, name: editorCopy.previewTitle })).toBeVisible();
    const acting = within(canvas.getByRole('region', { name: manageMessages.actingAs }));
    await expect(acting.getByText(actingName(persona))).toBeVisible();
    await expect(canvas.getByText(recordedDocument(persona, 'saved-preview-editor'))).toBeVisible();
    await expect(canvas.queryByRole('link', { name: surfaceText.community.en })).toBeNull();
    await expect(canvas.queryByRole('alert')).toBeNull();
  };
}

function loadingManagementPlay(): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(canvas.queryByRole('button', { name: editorCopy.save })).toBeNull();
    await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
  };
}

function savePlay(persona: EditorPersona): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole('heading', { level: 1, name: zoneTitle(persona, 'management-zone') })).resolves.toBeVisible();
    await expect(canvas.findByText(recordedDocument(persona, 'editor-save'))).resolves.toBeVisible();
    const save = canvas.getByRole('button', { name: editorCopy.save });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await expect(canvas.findByText(editorCopy.saved)).resolves.toBeVisible();
    const publish = canvas.getByRole('button', { name: editorCopy.publish });
    await waitFor(() => expect(publish).toBeEnabled());
    await userEvent.click(publish);
    await expect(canvas.findByText(editorCopy.published)).resolves.toBeVisible();
  };
}

function stalePlay(persona: EditorPersona): NonNullable<Story['play']> {
  return async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const saved = recordedDocument(persona, 'editor-save');
    const reopened = recordedDocument(persona, 'editor-reopen-draft');
    const save = await canvas.findByRole('button', { name: editorCopy.save });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(editorCopy.staleTitle);
    await userEvent.click(canvas.getByRole('button', { name: editorCopy.loadTheirs }));
    await expect(canvas.findByText(editorCopy.loaded)).resolves.toBeVisible();
    await expect(canvas.getByText(reopened)).toBeVisible();
    if (saved !== reopened) await expect(canvas.queryByText(saved)).toBeNull();
  };
}

export const VisitorRedirectPhone: Story = managementStory('visitor', 'redirect', 'phone', redirectPlay());
export const VisitorRedirectDesktop: Story = managementStory('visitor', 'redirect', 'desktop', redirectPlay());

export const ManagementStrangerPhone: Story = managementStory('stranger', 'manage', 'phone', deniedPlay('stranger'));
export const ManagementStrangerDesktop: Story = managementStory('stranger', 'manage', 'desktop', deniedPlay('stranger'));
export const ManagementMemberPhone: Story = managementStory('member', 'manage', 'phone', deniedPlay('member'));
export const ManagementMemberDesktop: Story = managementStory('member', 'manage', 'desktop', deniedPlay('member'));
export const ManagementOwnerPhone: Story = managementStory('owner', 'manage', 'phone', editorManagePlay('owner'));
export const ManagementOwnerDesktop: Story = managementStory('owner', 'manage', 'desktop', editorManagePlay('owner'));
export const ManagementModeratorPhone: Story = managementStory('moderator', 'manage', 'phone', deniedPlay('moderator'));
export const ManagementModeratorDesktop: Story = managementStory('moderator', 'manage', 'desktop', deniedPlay('moderator'));
export const ManagementOperatorPhone: Story = managementStory('operator', 'manage', 'phone', editorManagePlay('operator'));
export const ManagementOperatorDesktop: Story = managementStory('operator', 'manage', 'desktop', editorManagePlay('operator'));

export const ManagementLoadingStrangerPhone: Story = managementStory('stranger', 'manage-loading', 'phone', loadingManagementPlay());
export const ManagementLoadingStrangerDesktop: Story = managementStory('stranger', 'manage-loading', 'desktop', loadingManagementPlay());
export const ManagementLoadingMemberPhone: Story = managementStory('member', 'manage-loading', 'phone', loadingManagementPlay());
export const ManagementLoadingMemberDesktop: Story = managementStory('member', 'manage-loading', 'desktop', loadingManagementPlay());
export const ManagementLoadingOwnerPhone: Story = managementStory('owner', 'manage-loading', 'phone', loadingManagementPlay());
export const ManagementLoadingOwnerDesktop: Story = managementStory('owner', 'manage-loading', 'desktop', loadingManagementPlay());
export const ManagementLoadingModeratorPhone: Story = managementStory('moderator', 'manage-loading', 'phone', loadingManagementPlay());
export const ManagementLoadingModeratorDesktop: Story = managementStory('moderator', 'manage-loading', 'desktop', loadingManagementPlay());
export const ManagementLoadingOperatorPhone: Story = managementStory('operator', 'manage-loading', 'phone', loadingManagementPlay());
export const ManagementLoadingOperatorDesktop: Story = managementStory('operator', 'manage-loading', 'desktop', loadingManagementPlay());

export const PreviewStrangerPhone: Story = managementStory('stranger', 'preview', 'phone', deniedPlay('stranger'));
export const PreviewStrangerDesktop: Story = managementStory('stranger', 'preview', 'desktop', deniedPlay('stranger'));
export const PreviewMemberPhone: Story = managementStory('member', 'preview', 'phone', deniedPlay('member'));
export const PreviewMemberDesktop: Story = managementStory('member', 'preview', 'desktop', deniedPlay('member'));
export const PreviewOwnerPhone: Story = managementStory('owner', 'preview', 'phone', editorPreviewPlay('owner'));
export const PreviewOwnerDesktop: Story = managementStory('owner', 'preview', 'desktop', editorPreviewPlay('owner'));
export const PreviewModeratorPhone: Story = managementStory('moderator', 'preview', 'phone', deniedPlay('moderator'));
export const PreviewModeratorDesktop: Story = managementStory('moderator', 'preview', 'desktop', deniedPlay('moderator'));
export const PreviewOperatorPhone: Story = managementStory('operator', 'preview', 'phone', editorPreviewPlay('operator'));
export const PreviewOperatorDesktop: Story = managementStory('operator', 'preview', 'desktop', editorPreviewPlay('operator'));

export const PreviewLoadingStrangerPhone: Story = managementStory('stranger', 'preview-loading', 'phone', loadingManagementPlay());
export const PreviewLoadingStrangerDesktop: Story = managementStory('stranger', 'preview-loading', 'desktop', loadingManagementPlay());
export const PreviewLoadingMemberPhone: Story = managementStory('member', 'preview-loading', 'phone', loadingManagementPlay());
export const PreviewLoadingMemberDesktop: Story = managementStory('member', 'preview-loading', 'desktop', loadingManagementPlay());
export const PreviewLoadingOwnerPhone: Story = managementStory('owner', 'preview-loading', 'phone', loadingManagementPlay());
export const PreviewLoadingOwnerDesktop: Story = managementStory('owner', 'preview-loading', 'desktop', loadingManagementPlay());
export const PreviewLoadingModeratorPhone: Story = managementStory('moderator', 'preview-loading', 'phone', loadingManagementPlay());
export const PreviewLoadingModeratorDesktop: Story = managementStory('moderator', 'preview-loading', 'desktop', loadingManagementPlay());
export const PreviewLoadingOperatorPhone: Story = managementStory('operator', 'preview-loading', 'phone', loadingManagementPlay());
export const PreviewLoadingOperatorDesktop: Story = managementStory('operator', 'preview-loading', 'desktop', loadingManagementPlay());

export const OwnerSavePublishPhone: Story = managementStory('owner', 'save', 'phone', savePlay('owner'));
export const OwnerSavePublishDesktop: Story = managementStory('owner', 'save', 'desktop', savePlay('owner'));
export const OwnerStaleReopenPhone: Story = managementStory('owner', 'stale', 'phone', stalePlay('owner'));
export const OwnerStaleReopenDesktop: Story = managementStory('owner', 'stale', 'desktop', stalePlay('owner'));
export const OperatorSavePublishPhone: Story = managementStory('operator', 'save', 'phone', savePlay('operator'));
export const OperatorSavePublishDesktop: Story = managementStory('operator', 'save', 'desktop', savePlay('operator'));
export const OperatorStaleReopenPhone: Story = managementStory('operator', 'stale', 'phone', stalePlay('operator'));
export const OperatorStaleReopenDesktop: Story = managementStory('operator', 'stale', 'desktop', stalePlay('operator'));
