import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import homeRendering from '../../../../tests/qa/fixtures/outcomes/zone/home-rendering.json';
import { surfaceText } from '../address/messages.ts';
import { addressKey } from '../address/path.ts';
import type { RealmHeader, ZonePresentationRead } from '../realm/types.ts';
import { siteHref } from '../realm/route.ts';
import { realmMessagesFor } from '../realm/story-page.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { ZoneHomeRecordedPage } from './zone-home-recorded-page-view.tsx';
import { zoneSitePrefix } from './zone-site-recorded-page.ts';

const record = homeRendering as AnswerRecord;
const persona = 'visitor';
const locale = 'en';
const messages = zoneMessagesFor(locale);
const realmMessages = realmMessagesFor(locale);

function sample(label: string) {
  const found = record.personas[persona].find(answer => answer.label === label);
  if (!found) throw new Error(`Missing recorded zone home answer: ${label}`);
  return found;
}

function queryValue(label: string, name: string) {
  const value = new URL(sample(label).path, 'https://recorded.invalid').searchParams.get(name);
  if (value === null) throw new Error(`Recorded ${label} has no ${name}`);
  return value;
}

function presentationOf(label: string) {
  return sample(label).answer as ZonePresentationRead;
}

function recordedName(label: string) {
  const name = presentationOf(label).name;
  if (!name) throw new Error(`Recorded ${label} has no name`);
  return name;
}

function headerName() {
  const name = (sample('frame-published-realm-header').answer as RealmHeader).name.value;
  if (!name) throw new Error('Recorded realm header has no name');
  return name;
}

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  const nested = [node.doc, ...(Array.isArray(node.content) ? node.content : [])];
  return [node, ...nested.flatMap(nodes)];
}

function documentTexts(document: unknown): string[] {
  return nodes(document).flatMap(node => typeof node.text === 'string' ? [node.text] : []);
}

const published = presentationOf('frame-published-presentation');
const publishedHome = published.home;
if (!publishedHome) throw new Error('Recorded published presentation has no home');
const emptyPresentation = presentationOf('frame-empty-presentation');
const ownerText = documentTexts(publishedHome.document)[0];
const placeholder = publishedHome.blocks.find(block => block.status === 'placeholder');
const resolvedBlock = publishedHome.blocks.find(block => block.status === 'resolved');
if (!ownerText || !placeholder || !resolvedBlock) throw new Error('Recorded home is missing its text or blocks');
const recordedSlide = published.presentation.slides[0];
if (!recordedSlide || !('href' in recordedSlide) || typeof recordedSlide.title !== 'string') {
  throw new Error('Recorded home is missing its slide');
}
const slide = { title: recordedSlide.title, href: recordedSlide.href };
const mount = published.navigation[0];
if (!mount) throw new Error('Recorded home is missing its mount');
const draftPath = queryValue('unpublished-route-refused', 'path');
const publishedSpace = queryValue('frame-published-space-address', 'key');
const emptySpace = queryValue('frame-empty-space-address', 'key');
const publishedSelections = [
  { label: 'frame-published-space-address', state: 'populated' },
  { label: 'frame-published-presentation', state: 'populated' },
  { label: 'frame-published-realm-header', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

function refusalTitle(): string {
  const title = (sample('unpublished-route-refused').answer as { title?: string }).title;
  if (typeof title !== 'string') throw new Error('Recorded route refusal has no title');
  return title;
}

function privateDraftText() {
  const draft = record.personas.owner?.find(item => item.label === 'management-editor');
  const extra = documentTexts((draft?.answer as { draft?: { document?: unknown } } | undefined)?.draft?.document)
    .filter(text => !documentTexts(publishedHome?.document).includes(text));
  if (!extra[0]) throw new Error('The recorded owner draft has no text beyond the published home');
  return extra[0];
}

function siteAddress(address: ZonePresentationRead['address']) {
  if (address.prefix !== zoneSitePrefix) throw new Error(`Recorded site address prefix is ${address.prefix}`);
  return { prefix: zoneSitePrefix, key: address.key, suffixSource: address.suffixSource };
}

const homePath = (address: ZonePresentationRead['address'], path: readonly string[] = []) =>
  siteHref(locale, addressKey(siteAddress(address)), path);
const desktop = { locale, viewport: { value: 'desktop' } };
const phone = { locale, viewport: { value: 'phone' } };

function RecordedZoneHome({ space, selections, routePath, locale = 'en' }: {
  space: string; selections: readonly RecordedSelection[]; routePath?: string;
  locale?: import('../../i18n/define.ts').UiLocale;
}) {
  return <ZoneHomeRecordedPage record={record} persona={persona} locale={locale} space={space}
    selections={selections} routePath={routePath} />;
}

const meta = {
  title: 'Zones/Zone home',
  component: RecordedZoneHome,
  render: (args, { globals }) => <RecordedZoneHome {...args} locale={globals.locale as import('../../i18n/define.ts').UiLocale} />,
  parameters: { route: { pathname: homePath(published.address) } },
  globals: { locale },
} satisfies Meta<typeof RecordedZoneHome>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectPopulated(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const highlight = await canvas.findByRole('link', { name: slide.title });
  await expect(highlight).toHaveAttribute('href', slide.href);
  const prose = canvas.getByText(ownerText!);
  const unavailable = canvas.getByText(placeholder!.fallback);
  await expect(prose).toBeVisible();
  await expect(unavailable).toBeVisible();
  await expect(highlight.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await expect(prose.compareDocumentPosition(unavailable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await expect(canvas.queryByText(resolvedBlock!.fallback)).toBeNull();
  await expect(canvas.queryByText(privateDraftText())).toBeNull();
  await expect(canvas.getByRole('heading', { name: headerName() })).toBeVisible();
  await expect(canvas.queryByRole('heading', { name: recordedName('frame-published-presentation') })).toBeNull();
  const navigation = within(canvas.getByRole('navigation', { name: surfaceText.site[locale] }));
  const links = navigation.getAllByRole('link');
  await expect(links.map(link => link.textContent)).toEqual([realmMessages.home, mount!.name.value]);
  await expect(links[0]).toHaveAttribute('aria-current', 'page');
  const reference = navigation.getByRole('link', { name: mount!.name.value });
  await expect(reference.getAttribute('href') ?? '').toContain(mount!.segment);
  await expect(reference.getAttribute('href') ?? '').not.toContain('cursor');
}

async function expectEmpty(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: recordedName('frame-empty-presentation') })).toBeVisible();
  const navigation = within(canvas.getByRole('navigation', { name: recordedName('frame-empty-presentation') }));
  await expect(navigation.getByRole('link', { name: realmMessages.home })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.queryByRole('link', { name: mount!.name.value })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: recordedName('frame-published-presentation') })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: headerName() })).toBeNull();
  await expect(canvas.queryByText(ownerText!)).toBeNull();
  await expect(canvas.queryByText(placeholder!.fallback)).toBeNull();
  await expect(canvas.queryByText(realmMessages.emptyHomeTitle)).toBeNull();
}

async function expectRefusal(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { name: messages.pageMissingTitle })).toBeVisible();
  await expect(canvas.getByText(messages.pageMissingBody)).toBeVisible();
  await expect(canvas.getByRole('link', { name: messages.pageMissingBack })).toBeVisible();
  await expect(canvas.getByRole('heading', { name: headerName() })).toBeVisible();
  await expect(canvas.queryByRole('heading', { name: recordedName('frame-published-presentation') })).toBeNull();
  const navigation = within(canvas.getByRole('navigation', { name: surfaceText.site[locale] }));
  const reference = navigation.getByRole('link', { name: mount!.name.value });
  await expect(reference.getAttribute('href') ?? '').toContain(mount!.segment);
  await expect(reference.getAttribute('href') ?? '').not.toContain('cursor');
  await expect(canvas.queryByText(ownerText!)).toBeNull();
  await expect(canvas.queryByText(placeholder!.fallback)).toBeNull();
  await expect(canvas.queryByText(privateDraftText())).toBeNull();
  await expect(canvas.queryByRole('heading', { name: refusalTitle() })).toBeNull();
  await expect(canvas.queryByText(refusalTitle())).toBeNull();
}

async function expectLoading(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const status = await canvas.findByRole('status');
  await expect(status).toHaveTextContent(shellMessages.loading);
  await expect(status).toHaveAttribute('aria-busy', 'true');
  await expect(canvas.queryByRole('heading', { name: headerName() })).toBeNull();
  await expect(canvas.queryByRole('heading', { name: recordedName('frame-published-presentation') })).toBeNull();
  await expect(canvas.queryByText(ownerText!)).toBeNull();
  await expect(canvas.queryByText(placeholder!.fallback)).toBeNull();
}

export const PopulatedVisitor: Story = {
  args: { space: publishedSpace, selections: publishedSelections },
  globals: desktop,
  play: async ({ canvasElement }) => { await expectPopulated(canvasElement); },
};

export const PopulatedVisitorPhone: Story = { ...PopulatedVisitor, globals: phone };

export const EmptyVisitor: Story = {
  args: {
    space: emptySpace,
    selections: [
      { label: 'frame-empty-space-address', state: 'populated' },
      { label: 'frame-empty-presentation', state: 'empty' },
    ],
  },
  globals: desktop,
  parameters: { route: { pathname: homePath(emptyPresentation.address) } },
  play: async ({ canvasElement }) => { await expectEmpty(canvasElement); },
};

export const EmptyVisitorPhone: Story = { ...EmptyVisitor, globals: phone };

export const ErrorVisitor: Story = {
  args: {
    space: publishedSpace,
    selections: [...publishedSelections, { label: 'unpublished-route-refused', state: 'error' }],
    routePath: draftPath,
  },
  globals: desktop,
  parameters: { route: { pathname: homePath(published.address, draftPath.split('/').filter(Boolean)) } },
  play: async ({ canvasElement }) => { await expectRefusal(canvasElement); },
};

export const ErrorVisitorPhone: Story = { ...ErrorVisitor, globals: phone };

export const LoadingVisitor: Story = {
  args: {
    space: publishedSpace,
    selections: [
      { label: 'frame-published-space-address', state: 'loading' },
      { label: 'frame-published-presentation', state: 'populated' },
      { label: 'frame-published-realm-header', state: 'populated' },
    ],
  },
  globals: desktop,
  play: async ({ canvasElement }) => { await expectLoading(canvasElement); },
};

export const LoadingVisitorPhone: Story = { ...LoadingVisitor, globals: phone };
