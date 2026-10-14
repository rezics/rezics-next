import { documentText } from '@rezics/document';
import type { CanonicalAddress } from '@rezics/model/address';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import publication from '../../../../tests/qa/fixtures/outcomes/zone/publication.json';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { surfaceText } from '../address/messages.ts';
import { spaceHref } from '../address/path.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import realmDe from '../realm/messages/de.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages } from '../zones/messages.ts';
import { zoneSitePrefix } from '../zones/zone-site-recorded-page.ts';
import { zoneHomeDocument, zoneHomeProse, type ZoneHomePage } from './home-document.tsx';
import { messages as editorMessages } from './messages.ts';
import { zoneEditorPath } from './routes.ts';
import { ZonePublicationCommandPage, ZonePublicationManagementPage, ZonePublicationRecordedPage } from './zone-publication-recorded-page.tsx';
import { managementVisit, recordedActingPerson, recordedPublicationChoice } from './zone-publication-recorded-page.ts';

const record = publication as AnswerRecord;

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].filter(item => item.label === label);
  if (found.length !== 1) throw new Error(`Missing recorded sample ${persona}/${label}`);
  return found[0]!;
}

function answerOf(persona: AnswerPersona, label: string): {
  name?: unknown;
  home?: unknown;
  address?: { prefix?: unknown; key?: unknown; suffixSource?: unknown };
  canonical?: { prefix?: unknown; key?: unknown; suffixSource?: unknown };
  navigation?: { name?: { value?: unknown } }[];
  presentation?: { tokens?: { pageSurface?: unknown } };
} {
  const answer = sample(persona, label).answer;
  if (!answer || typeof answer !== 'object') throw new Error(`Recorded ${persona}/${label} has no answer`);
  return answer as ReturnType<typeof answerOf>;
}

function recordedName(persona: AnswerPersona, label: string): string {
  const name = answerOf(persona, label).name;
  if (typeof name !== 'string' || !name) throw new Error(`Recorded ${persona}/${label} has no name`);
  return name;
}

function recordedPage(persona: AnswerPersona, label: string): ZoneHomePage {
  const home = answerOf(persona, label).home;
  if (!zoneHomeDocument(home)) throw new Error(`Recorded ${persona}/${label} has no home document`);
  return home as ZoneHomePage;
}

/** Slides the public home promotes in place of a resolved default Showcase. An empty slide list leaves the fallback in the prose. */
function promotedSlides(page: ZoneHomePage): { title: string; href: string }[] {
  const showcase = page.showcases?.find(item => item.id === '$default' && item.module === null);
  if (!showcase || !page.showcaseData) return [];
  return (showcase.slides ?? page.showcaseData.slides).flatMap(slide =>
    typeof slide.title === 'string' && slide.title && 'href' in slide && typeof slide.href === 'string'
      ? [{ title: slide.title, href: slide.href }] : []);
}

function recordedLines(persona: AnswerPersona, label: string): string[] {
  const page = recordedPage(persona, label);
  const document = zoneHomeDocument(page);
  if (!document) throw new Error(`Recorded ${persona}/${label} has no home document`);
  const represented = promotedSlides(page).length > 0 ? ['$default'] : [];
  return documentText(zoneHomeProse(document, page.blocks, represented)).split('\n').filter(line => line.length > 0);
}

function recordedCredit(persona: AnswerPersona, label: string): { rightsBasis: string; author: string } {
  const home = answerOf(persona, label).home as { reference?: { provenance?: { rightsBasis?: unknown; author?: unknown } } } | undefined;
  const provenance = home?.reference?.provenance;
  if (typeof provenance?.rightsBasis !== 'string' || typeof provenance.author !== 'string') {
    throw new Error(`Recorded ${persona}/${label} has no credit`);
  }
  return { rightsBasis: provenance.rightsBasis, author: provenance.author };
}

const ownerAuthor = recordedCredit('visitor', 'published-presentation').author;

function recordedMounts(persona: AnswerPersona, label: string): string[] {
  return (answerOf(persona, label).navigation ?? []).map(item => {
    if (typeof item.name?.value !== 'string') throw new Error(`Recorded ${persona}/${label} mount has no name`);
    return item.name.value;
  });
}

function recordedSurface(persona: AnswerPersona, label: string): string {
  const surface = answerOf(persona, label).presentation?.tokens?.pageSurface;
  if (typeof surface !== 'string') throw new Error(`Recorded ${persona}/${label} has no page surface`);
  return surface;
}

function recordedAddress(persona: AnswerPersona, label: string): CanonicalAddress {
  const answer = answerOf(persona, label);
  const address = answer.canonical ?? answer.address;
  if (!address || address.prefix !== zoneSitePrefix || typeof address.key !== 'string' || typeof address.suffixSource !== 'string') {
    throw new Error(`Recorded ${persona}/${label} has no site address`);
  }
  return { prefix: zoneSitePrefix, key: address.key, suffixSource: address.suffixSource };
}

function recordedPath(persona: AnswerPersona, label: string, locale: UiLocale = 'en', tail: readonly string[] = []): string {
  return localizedPath(spaceHref(recordedAddress(persona, label), 'site', tail), locale);
}

const publishedFrame = [
  { label: 'frame-published-address', state: 'populated' },
  { label: 'frame-published-presentation', state: 'populated' },
  { label: 'frame-published-realm-header', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const signedFrame = [
  ...publishedFrame,
  { label: 'frame-published-joining', state: 'populated' },
  { label: 'frame-published-follow', state: 'populated' },
  { label: 'frame-published-platform-access', state: 'populated' },
  { label: 'frame-published-member-ban', state: 'error' },
] as const satisfies readonly RecordedSelection[];
const unchanged = [
  { label: 'frame-published-address', state: 'populated' },
  { label: 'unchanged-public-presentation', state: 'populated' },
  { label: 'frame-published-realm-header', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const empty = [
  { label: 'frame-empty-address', state: 'populated' },
  { label: 'empty-home-presentation', state: 'empty' },
] as const satisfies readonly RecordedSelection[];
const draftRefused = [
  { label: 'site-address', state: 'populated' },
  { label: 'published-draft-route-refused', state: 'error' },
] as const satisfies readonly RecordedSelection[];
const loading = [
  { label: 'frame-published-address', state: 'populated' },
  { label: 'frame-published-presentation', state: 'loading' },
] as const satisfies readonly RecordedSelection[];
const selected = [
  { label: 'frame-published-address', state: 'populated' },
  { label: 'selected-presentation', state: 'populated' },
  { label: 'frame-published-realm-header', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const mandatedFrame = [
  { label: 'frame-empty-address', state: 'populated' },
  { label: 'frame-empty-presentation', state: 'populated' },
  { label: 'frame-empty-route', state: 'populated' },
  { label: 'frame-published-realm-header', state: 'populated' },
  { label: 'frame-published-joining', state: 'populated' },
  { label: 'frame-published-follow', state: 'populated' },
  { label: 'frame-published-platform-access', state: 'populated' },
  { label: 'frame-published-member-ban', state: 'error' },
] as const satisfies readonly RecordedSelection[];

const meta = {
  title: 'Zone editor/Recorded publication',
  component: ZonePublicationRecordedPage,
  args: { record, persona: 'visitor' as const, selections: publishedFrame, locale: 'en' as const },
  render: (args, { globals }) => (
    <ZonePublicationRecordedPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof ZonePublicationRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

function homeLabel(locale: UiLocale): string {
  return locale === 'de' ? realmDe.home : realmMessages.home;
}

async function expectLines(canvas: ReturnType<typeof within>, lines: readonly string[]) {
  for (const line of lines) await expect(canvas.getByText(line)).toBeVisible();
}

function realmHeading(persona: AnswerPersona): string {
  const name = answerOf(persona, 'frame-published-realm-header').name;
  if (!name || typeof name !== 'object' || typeof (name as { value?: unknown }).value !== 'string') {
    throw new Error(`Recorded ${persona} realm header has no name`);
  }
  return (name as { value: string }).value;
}

function showFrame(persona: AnswerPersona, label: string, locale: UiLocale = 'en') {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const page = recordedPage(persona, label);
    const lines = recordedLines(persona, label);
    const slides = promotedSlides(page);
    const credit = recordedCredit(persona, label);
    const acting = recordedActingPerson(record, persona, [{ label, state: 'populated' }]);
    await expect(canvas.findByRole('region', { name: persona })).resolves.toBeVisible();
    if (acting) await expect(canvas.findByText(acting)).resolves.toBeVisible();
    await expect(canvas.findByRole('heading', { level: 1, name: realmHeading(persona) })).resolves.toBeVisible();
    await expectLines(canvas, lines);
    for (const slide of slides) {
      const link = canvas.getByRole('link', { name: slide.title });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', slide.href);
    }
    for (const block of page.blocks) {
      if (slides.length > 0 && block.status === 'resolved' && block.showcase === '$default') {
        await expect(canvas.queryByText(block.fallback)).toBeNull();
      }
    }
    await expect(canvas.getByText(credit.rightsBasis)).toBeVisible();
    await expect(canvas.getAllByText(credit.author).length).toBeGreaterThan(0);
    await expect(canvas.getAllByText(ownerAuthor).length).toBeGreaterThan(0);
    await expect(canvas.getByRole('navigation', { name: surfaceText.site[locale] })).toBeVisible();
    await expect(canvas.getByRole('link', { name: homeLabel(locale) })).toBeVisible();
    const counts = new Map<string, number>();
    for (const mount of recordedMounts(persona, label)) counts.set(mount, (counts.get(mount) ?? 0) + 1);
    for (const [mount, count] of counts) await expect(canvas.getAllByRole('link', { name: mount })).toHaveLength(count);
    await expect(canvasElement.querySelector('[data-zone-site-home-surface]'))
      .toHaveAttribute('data-zone-site-home-surface', recordedSurface(persona, label));
  };
}

function showEmpty(persona: AnswerPersona, label: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const name = recordedName(persona, label);
    await expect(canvas.findByRole('region', { name: persona })).resolves.toBeVisible();
    await expect(canvas.findByRole('heading', { level: 1, name })).resolves.toBeVisible();
    await expect(canvas.getByRole('link', { name: realmMessages.home })).toBeVisible();
    await expect(canvasElement.querySelector('[data-zone-members]')).toBeTruthy();
    await expect(canvas.queryByText('original-contribution')).toBeNull();
    await expect(canvas.queryByText(recordedLines('visitor', 'published-presentation')[0]!)).toBeNull();
  };
}

function showDraftRefused({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  return expect(canvas.findByRole('region', { name: 'visitor' })).resolves.toBeVisible().then(async () => {
    await expect(canvas.findByRole('heading', { level: 1, name: messages.pageMissingTitle })).resolves.toBeVisible();
    await expect(canvas.getByText(messages.pageMissingBody)).toBeVisible();
    await expect(canvas.getByRole('link', { name: messages.pageMissingBack })).toHaveAttribute('href', recordedPath('visitor', 'site-address'));
    await expect(canvas.queryByText(recordedLines('visitor', 'published-presentation')[0]!)).toBeNull();
  });
}

function showLoading({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  return expect(canvas.findByRole('region', { name: 'visitor' })).resolves.toBeVisible().then(async () => {
    await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
    await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
    await expect(canvas.queryByText(recordedLines('visitor', 'published-presentation')[0]!)).toBeNull();
  });
}

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { ...story.globals, viewport: { value: viewport } } };
}

const publishedVisitor = {
  args: { selections: publishedFrame },
  parameters: { route: { pathname: recordedPath('visitor', 'frame-published-presentation') } },
  play: showFrame('visitor', 'frame-published-presentation'),
} satisfies Story;
const publishedVisitorGerman = {
  args: { selections: publishedFrame, locale: 'de' as const },
  globals: { locale: 'de' as const },
  parameters: { route: { pathname: recordedPath('visitor', 'frame-published-presentation', 'de') } },
  play: showFrame('visitor', 'frame-published-presentation', 'de'),
} satisfies Story;
const unchangedVisitor = {
  args: { selections: unchanged },
  parameters: { route: { pathname: recordedPath('visitor', 'unchanged-public-presentation') } },
  play: showFrame('visitor', 'unchanged-public-presentation'),
} satisfies Story;
const emptyVisitor = {
  args: { selections: empty },
  parameters: { route: { pathname: recordedPath('visitor', 'empty-home-presentation') } },
  play: showEmpty('visitor', 'empty-home-presentation'),
} satisfies Story;
const draftRefusedVisitor = {
  args: { selections: draftRefused },
  parameters: { route: { pathname: recordedPath('visitor', 'site-address', 'en', ['draft-link']) } },
  play: showDraftRefused,
} satisfies Story;
const loadingVisitor = {
  args: { selections: loading },
  parameters: { route: { pathname: recordedPath('visitor', 'published-presentation') } },
  play: showLoading,
} satisfies Story;

function signedPersona(persona: AnswerPersona): Story {
  return {
    args: { persona, selections: signedFrame },
    parameters: { route: { pathname: recordedPath(persona, 'frame-published-presentation') } },
    play: showFrame(persona, 'frame-published-presentation'),
  };
}

const selectedOwner = {
  args: { persona: 'owner' as const, selections: selected },
  parameters: { route: { pathname: recordedPath('owner', 'selected-presentation') } },
  play: showFrame('owner', 'selected-presentation'),
} satisfies Story;
const competingOwner = {
  args: { persona: 'owner' as const, selections: signedFrame },
  parameters: { route: { pathname: recordedPath('owner', 'frame-published-presentation') } },
  play: showFrame('owner', 'frame-published-presentation'),
} satisfies Story;
const mandatedOperator = {
  args: { persona: 'operator' as const, selections: mandatedFrame },
  parameters: { route: { pathname: recordedPath('operator', 'frame-empty-presentation') } },
  play: showFrame('operator', 'frame-empty-presentation'),
} satisfies Story;

export const PublishedVisitorPhone: Story = at(publishedVisitor, 'phone');
export const PublishedVisitorDesktop: Story = at(publishedVisitor, 'desktop');
export const PublishedVisitorGermanPhone: Story = at(publishedVisitorGerman, 'phone');
export const PublishedVisitorGermanDesktop: Story = at(publishedVisitorGerman, 'desktop');
export const UnchangedVisitorPhone: Story = at(unchangedVisitor, 'phone');
export const UnchangedVisitorDesktop: Story = at(unchangedVisitor, 'desktop');
export const EmptyVisitorPhone: Story = at(emptyVisitor, 'phone');
export const EmptyVisitorDesktop: Story = at(emptyVisitor, 'desktop');
export const DraftRefusedVisitorPhone: Story = at(draftRefusedVisitor, 'phone');
export const DraftRefusedVisitorDesktop: Story = at(draftRefusedVisitor, 'desktop');
export const LoadingVisitorPhone: Story = at(loadingVisitor, 'phone');
export const LoadingVisitorDesktop: Story = at(loadingVisitor, 'desktop');
export const FrameStrangerPhone: Story = at(signedPersona('stranger'), 'phone');
export const FrameStrangerDesktop: Story = at(signedPersona('stranger'), 'desktop');
export const FrameMemberPhone: Story = at(signedPersona('member'), 'phone');
export const FrameMemberDesktop: Story = at(signedPersona('member'), 'desktop');
export const FrameModeratorPhone: Story = at(signedPersona('moderator'), 'phone');
export const FrameModeratorDesktop: Story = at(signedPersona('moderator'), 'desktop');
export const FrameOperatorPhone: Story = at(signedPersona('operator'), 'phone');
export const FrameOperatorDesktop: Story = at(signedPersona('operator'), 'desktop');
export const SelectedOwnerPhone: Story = at(selectedOwner, 'phone');
export const SelectedOwnerDesktop: Story = at(selectedOwner, 'desktop');
export const CompetingOwnerPhone: Story = at(competingOwner, 'phone');
export const CompetingOwnerDesktop: Story = at(competingOwner, 'desktop');
export const MandatedOperatorPhone: Story = at(mandatedOperator, 'phone');
export const MandatedOperatorDesktop: Story = at(mandatedOperator, 'desktop');

function showCommand(persona: AnswerPersona, commandLabel: string, clicks = 1) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const command = recordedPublicationChoice(record, persona, commandLabel);
    await expect(canvas.findByRole('region', { name: persona })).resolves.toBeVisible();
    await expect(canvas.getByText(command.actingSubject)).toBeVisible();
    const publishButton = () => canvas.getByRole('button', { name: editorMessages.en.publishReviewed });
    for (let index = 0; index < clicks; index += 1) {
      await waitFor(() => expect(publishButton()).toBeEnabled());
      await userEvent.click(publishButton());
      await expect(canvas.findByText(command.choice.page)).resolves.toBeVisible();
    }
    if (clicks > 1) {
      await waitFor(() => expect(canvas.queryByText(editorMessages.en.published)).toBeNull());
      await expect(canvas.getAllByText(command.choice.revisionId)).toHaveLength(2);
    } else {
      await expect(canvas.getByText(editorMessages.en.published)).toBeVisible();
      await expect(canvas.getByText(command.choice.revisionId)).toBeVisible();
    }
    await expect(canvas.getByText(command.choice.byteDigest)).toBeVisible();
  };
}

function showRefusal(persona: AnswerPersona) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const refused = sample(persona, 'owner-receipt-refused').answer as { title: string; code: string };
    await userEvent.click(canvas.getByRole('button', { name: editorMessages.en.publishReviewed }));
    await expect(canvas.findByRole('alert')).resolves.toHaveTextContent(refused.title);
    await expect(canvas.getByText(refused.code)).toBeVisible();
    await expect(canvas.queryByText(recordedLines('visitor', 'published-presentation')[0]!)).toBeNull();
  };
}

function commandStory(persona: AnswerPersona, commandLabel: string, presentationLabel: string, sequence = false, clicks = 1): Story {
  const selections = sequence
    ? [{ label: 'publication-acknowledgement', state: 'populated' as const }, { label: 'receipt-replay', state: 'populated' as const }]
    : [{ label: commandLabel, state: 'populated' as const }];
  return {
    args: { persona, selections, locale: 'en' },
    render: () => <ZonePublicationCommandPage record={record} persona={persona} selections={selections} locale="en"
      commandLabel={commandLabel} presentationLabel={presentationLabel} sequence={sequence} />,
    play: showCommand(persona, commandLabel, clicks),
  };
}

function refusalStory(persona: AnswerPersona): Story {
  const selections = [{ label: 'owner-receipt-refused', state: 'error' as const }] as const satisfies readonly RecordedSelection[];
  return {
    args: { persona, selections, locale: 'en' },
    render: () => <ZonePublicationCommandPage record={record} persona={persona} selections={selections} locale="en"
      commandLabel="owner-receipt-refused" presentationLabel="published-presentation" />,
    play: showRefusal(persona),
  };
}

export const ReceiptReplayPhone: Story = at(commandStory('owner', 'publication-acknowledgement', 'selected-presentation', true, 2), 'phone');
export const ReceiptReplayDesktop: Story = at(commandStory('owner', 'publication-acknowledgement', 'selected-presentation', true, 2), 'desktop');
export const CompetingPublishPhone: Story = at(commandStory('owner', 'competing-publication', 'competing-presentation'), 'phone');
export const CompetingPublishDesktop: Story = at(commandStory('owner', 'competing-publication', 'competing-presentation'), 'desktop');
export const MandatedPublishPhone: Story = at(commandStory('operator', 'mandated-publication', 'frame-empty-presentation'), 'phone');
export const MandatedPublishDesktop: Story = at(commandStory('operator', 'mandated-publication', 'frame-empty-presentation'), 'desktop');
export const RefuseVisitorPhone: Story = at(refusalStory('visitor'), 'phone');
export const RefuseVisitorDesktop: Story = at(refusalStory('visitor'), 'desktop');
export const RefuseStrangerPhone: Story = at(refusalStory('stranger'), 'phone');
export const RefuseStrangerDesktop: Story = at(refusalStory('stranger'), 'desktop');
export const RefuseMemberPhone: Story = at(refusalStory('member'), 'phone');
export const RefuseMemberDesktop: Story = at(refusalStory('member'), 'desktop');
export const RefuseModeratorPhone: Story = at(refusalStory('moderator'), 'phone');
export const RefuseModeratorDesktop: Story = at(refusalStory('moderator'), 'desktop');
export const RefuseOperatorPhone: Story = at(refusalStory('operator'), 'phone');
export const RefuseOperatorDesktop: Story = at(refusalStory('operator'), 'desktop');

const zoneId = new URL(sample('owner', 'manage-configuration').path, 'https://recorded.invalid').pathname.split('/')[3]!;
const ownerActing = new URL(sample('owner', 'manage-configuration').path, 'https://recorded.invalid').searchParams.get('actingSubject')!;
const managementReady = [
  { label: 'manage-configuration', state: 'populated' },
  { label: 'manage-space-address', state: 'populated' },
  { label: 'site-editor-access', state: 'populated' },
  { label: 'manage-zone', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const managementLoading = [{ label: 'manage-configuration', state: 'loading' }] as const satisfies readonly RecordedSelection[];

function managementRoute(locale: UiLocale = 'en') {
  return localizedPath(zoneEditorPath(zoneId), locale);
}

function editorLine(): string {
  const answer = sample('owner', 'site-editor-access').answer as { draft?: { document?: unknown } };
  const text = answer.draft?.document ? documentText(answer.draft.document as Parameters<typeof documentText>[0]) : '';
  const line = text.split('\n').find(item => item.length > 0);
  if (!line) throw new Error('Recorded owner editor has no document text');
  return line;
}

function showManagement(persona: AnswerPersona, locale: UiLocale = 'en') {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const visit = managementVisit(record, persona, [{ label: 'manage-configuration', state: 'error' }]);
    const copy = editorMessages[locale];
    await expect(canvas.findByRole('region', { name: persona })).resolves.toBeVisible();
    await expect(canvas.getByText(visit.actingSubject)).toBeVisible();
    await expect(canvas.findByRole('heading', { level: 1, name: zoneId })).resolves.toBeVisible();
    await expect(canvas.findByRole('alert')).resolves.toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: copy.deniedTitle })).toBeVisible();
    await expect(canvas.getByText(copy.deniedBody)).toBeVisible();
    await expect(canvas.queryByText(editorLine())).toBeNull();
  };
}

function showOwnerEditor({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const line = editorLine();
  return expect(canvas.findByRole('region', { name: 'owner' })).resolves.toBeVisible().then(async () => {
    await expect(canvas.getByText(ownerActing)).toBeVisible();
    await expect(canvas.findByRole('heading', { level: 1, name: (sample('owner', 'manage-configuration').answer as { name: string }).name })).resolves.toBeVisible();
    await expect(canvas.getByRole('heading', { level: 2, name: editorMessages.en.homeTitle })).toBeVisible();
    await waitFor(() => expect(canvas.getByRole('textbox', { name: editorMessages.en.editorLabel })).toHaveTextContent(line));
    await expect(canvas.getByText(editorMessages.en.statusBehind)).toBeVisible();
    await expect(canvas.getByRole('link', { name: editorMessages.en.viewSite })).toHaveAttribute('href',
      localizedPath(spaceHref(recordedAddress('owner', 'manage-space-address'), 'site'), 'en'));
  });
}

function showManagementLoading({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  return expect(canvas.findByRole('region', { name: 'owner' })).resolves.toBeVisible().then(async () => {
    await expect(canvas.getByText(ownerActing)).toBeVisible();
    await expect(canvas.findByRole('status', { name: shellMessages.loading })).resolves.toBeVisible();
    await expect(canvas.queryByRole('heading', { level: 1 })).toBeNull();
    await expect(canvas.queryByText(editorLine())).toBeNull();
  });
}

const managementMeta = { render: (args: { persona: AnswerPersona; selections: readonly RecordedSelection[]; locale: UiLocale }, context: { globals: { locale?: UiLocale } }) =>
  <ZonePublicationManagementPage record={record} persona={args.persona} selections={args.selections}
    locale={context.globals.locale ?? args.locale} /> };

function refusedManagement(persona: AnswerPersona, locale: UiLocale = 'en'): Story {
  return {
    args: { persona, selections: [
      { label: 'manage-configuration', state: 'error' },
      { label: 'site-address', state: 'populated' },
      { label: 'site-editor-access', state: 'error' },
      { label: 'manage-zone', state: 'error' },
    ], locale },
    globals: locale === 'en' ? undefined : { locale },
    parameters: { route: { pathname: managementRoute(locale) } },
    ...managementMeta,
    play: showManagement(persona, locale),
  } as Story;
}

export const ManagementStrangerPhone: Story = at(refusedManagement('stranger'), 'phone');
export const ManagementStrangerDesktop: Story = at(refusedManagement('stranger'), 'desktop');
export const ManagementMemberPhone: Story = at(refusedManagement('member'), 'phone');
export const ManagementMemberDesktop: Story = at(refusedManagement('member'), 'desktop');
export const ManagementModeratorPhone: Story = at(refusedManagement('moderator'), 'phone');
export const ManagementModeratorDesktop: Story = at(refusedManagement('moderator'), 'desktop');
export const ManagementOperatorPhone: Story = at(refusedManagement('operator'), 'phone');
export const ManagementOperatorDesktop: Story = at(refusedManagement('operator'), 'desktop');
export const ManagementStrangerGermanPhone: Story = at(refusedManagement('stranger', 'de'), 'phone');
export const ManagementStrangerGermanDesktop: Story = at(refusedManagement('stranger', 'de'), 'desktop');
export const ManagementOwnerPhone: Story = at({
  args: { persona: 'owner', selections: managementReady, locale: 'en' },
  parameters: { route: { pathname: managementRoute() } },
  ...managementMeta,
  play: showOwnerEditor,
} as Story, 'phone');
export const ManagementOwnerDesktop: Story = at({
  args: { persona: 'owner', selections: managementReady, locale: 'en' },
  parameters: { route: { pathname: managementRoute() } },
  ...managementMeta,
  play: showOwnerEditor,
} as Story, 'desktop');
export const ManagementLoadingPhone: Story = at({
  args: { persona: 'owner', selections: managementLoading, locale: 'en' },
  parameters: { route: { pathname: managementRoute() } },
  ...managementMeta,
  play: showManagementLoading,
} as Story, 'phone');
export const ManagementLoadingDesktop: Story = at({
  args: { persona: 'owner', selections: managementLoading, locale: 'en' },
  parameters: { route: { pathname: managementRoute() } },
  ...managementMeta,
  play: showManagementLoading,
} as Story, 'desktop');
