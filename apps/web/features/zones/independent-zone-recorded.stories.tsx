import { documentText } from '@rezics/document';
import type { CanonicalAddress } from '@rezics/model/address';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import independentZone from '../../../../tests/qa/fixtures/outcomes/zone/a-zone-without-a-realm.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { addressKey } from '../address/path.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { zoneEditorPath } from '../zone-editor/routes.ts';
import { zoneHomeDocument } from '../zone-editor/home-document.tsx';
import { IndependentZoneRecordedPage } from './independent-zone-recorded-page.tsx';

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
    { label: 'page-home-route', state: 'populated' },
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
  if (!address || address.prefix !== '/z/' || typeof address.key !== 'string' || typeof address.suffixSource !== 'string') {
    throw new Error(`${persona} address has no site canonical`);
  }
  return { prefix: '/z/', key: address.key, suffixSource: address.suffixSource };
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
