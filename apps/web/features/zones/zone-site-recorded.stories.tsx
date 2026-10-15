import { creditText } from '../zones/credit-messages.ts';
import { profileHref } from '../profile/route.ts';
import { documentText } from '@rezics/document';
import type { CanonicalAddress } from '@rezics/model/address';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import sitePages from '../../../../tests/qa/fixtures/outcomes/zone/site-pages.json';
import { localizedPath } from '../../i18n/locale.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { spaceHref } from '../address/path.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { zoneHomeDocument } from '../zone-editor/home-document.tsx';
import { messages } from './messages.ts';
import { ZoneSiteRecordedPage } from './zone-site-recorded-page.tsx';
import { zoneSitePrefix } from './zone-site-recorded-page.ts';

const record = sitePages as AnswerRecord;

function visitor(label: string) {
  const sample = record.personas.visitor.find(item => item.label === label);
  if (!sample) throw new Error(`Missing visitor sample ${label}`);
  return sample;
}

function recordedName(label: string): string {
  const name = (visitor(label).answer as { name?: unknown }).name;
  if (typeof name !== 'string' || !name) throw new Error(`Recorded ${label} has no name`);
  return name;
}

function recordedHomeText(label: string): string {
  const home = (visitor(label).answer as { home?: unknown }).home;
  const document = zoneHomeDocument(home);
  if (!document) throw new Error(`Recorded ${label} has no home document`);
  return documentText(document);
}

function recordedCredit(label: string): { rightsBasis: string; author: string } {
  const home = (visitor(label).answer as { home?: { reference?: { provenance?: { rightsBasis?: unknown; author?: unknown } } } }).home;
  const provenance = home?.reference?.provenance;
  if (typeof provenance?.rightsBasis !== 'string' || typeof provenance.author !== 'string') {
    throw new Error(`Recorded ${label} has no credit`);
  }
  return { rightsBasis: provenance.rightsBasis, author: provenance.author };
}

function recordedAddress(label: string): CanonicalAddress {
  const answer = visitor(label).answer as {
    address?: { prefix?: unknown; key?: unknown; suffixSource?: unknown };
    canonical?: { prefix?: unknown; key?: unknown; suffixSource?: unknown };
  };
  const address = answer.canonical ?? answer.address;
  if (!address || address.prefix !== zoneSitePrefix || typeof address.key !== 'string' || typeof address.suffixSource !== 'string') {
    throw new Error(`Recorded ${label} has no site address`);
  }
  return { prefix: zoneSitePrefix, key: address.key, suffixSource: address.suffixSource };
}

function recordedPath(label: string, tail: readonly string[] = []): string {
  return localizedPath(spaceHref(recordedAddress(label), 'site', tail), 'en');
}

const populated = [
  { label: 'published-presentation', state: 'populated' },
  { label: 'published-home-route', state: 'populated' },
  { label: 'published-content-revision', state: 'populated' },
] as const satisfies readonly RecordedSelection[];
const empty = [{ label: 'empty-home-presentation', state: 'empty' }] as const satisfies readonly RecordedSelection[];
const refusal = [
  { label: 'space-address', state: 'populated' },
  { label: 'missing-route-refused', state: 'error' },
] as const satisfies readonly RecordedSelection[];
const loading = [
  { label: 'published-presentation', state: 'loading' },
  { label: 'published-home-route', state: 'populated' },
  { label: 'published-content-revision', state: 'populated' },
] as const satisfies readonly RecordedSelection[];

const meta = {
  title: 'Zones/Recorded site',
  component: ZoneSiteRecordedPage,
  args: { record, persona: 'visitor' as const, selections: populated, locale: 'en' as const },
  render: (args, { globals }) => (
    <ZoneSiteRecordedPage {...args} locale={(globals.locale as UiLocale | undefined) ?? args.locale} />
  ),
} satisfies Meta<typeof ZoneSiteRecordedPage>;
export default meta;
type Story = StoryObj<typeof meta>;

async function publishedPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  const text = recordedHomeText('published-presentation');
  const credit = recordedCredit('published-presentation');
  await expect(canvas.findByRole('heading', { level: 1, name: recordedName('published-presentation') })).resolves.toBeVisible();
  await expect(canvas.getByText(text)).toBeVisible();
  await expect(canvas.getByText(creditText.en.original)).toBeVisible();
  await expect(canvas.getByRole('link', { name: creditText.en.contributor })).toHaveAttribute('href', localizedPath(profileHref({ handle: null, id: credit.author }), 'en'));
  await expect(canvas.getByRole('link', { name: realmMessages.home })).toBeVisible();
}

async function emptyPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('heading', { level: 1, name: recordedName('empty-home-presentation') })).resolves.toBeVisible();
  await expect(canvas.queryByText(recordedHomeText('published-presentation'))).toBeNull();
}

async function refusalPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('heading', { level: 1, name: messages.pageMissingTitle })).resolves.toBeVisible();
  await expect(canvas.getByText(messages.pageMissingBody)).toBeVisible();
  await expect(canvas.getByRole('link', { name: messages.pageMissingBack })).toHaveAttribute('href', recordedPath('space-address'));
  await expect(canvas.queryByText(recordedHomeText('published-presentation'))).toBeNull();
  await expect(canvas.queryByRole('heading', { name: realmMessages.notFoundTitle })).toBeNull();
}

async function loadingPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await expect(canvas.findByRole('status')).resolves.toHaveTextContent(shellMessages.loading);
  await expect(canvas.queryByText(recordedHomeText('published-presentation'))).toBeNull();
}

const populatedVisitor = {
  parameters: { route: { pathname: recordedPath('published-presentation') } },
  play: publishedPlay,
} satisfies Story;
const emptyVisitor = {
  args: { selections: empty },
  parameters: { route: { pathname: recordedPath('empty-home-presentation') } },
  play: emptyPlay,
} satisfies Story;
const refusalVisitor = {
  args: { selections: refusal },
  parameters: { route: { pathname: recordedPath('space-address', ['missing']) } },
  play: refusalPlay,
} satisfies Story;
const loadingVisitor = {
  args: { selections: loading },
  parameters: { route: { pathname: recordedPath('published-presentation') } },
  play: loadingPlay,
} satisfies Story;

function at(story: Story, viewport: 'phone' | 'desktop'): Story {
  return { ...story, globals: { viewport: { value: viewport } } };
}

export const PopulatedVisitorPhone: Story = at(populatedVisitor, 'phone');
export const PopulatedVisitorDesktop: Story = at(populatedVisitor, 'desktop');
export const EmptyVisitorPhone: Story = at(emptyVisitor, 'phone');
export const EmptyVisitorDesktop: Story = at(emptyVisitor, 'desktop');
export const RefusalVisitorPhone: Story = at(refusalVisitor, 'phone');
export const RefusalVisitorDesktop: Story = at(refusalVisitor, 'desktop');
export const LoadingVisitorPhone: Story = at(loadingVisitor, 'phone');
export const LoadingVisitorDesktop: Story = at(loadingVisitor, 'desktop');
