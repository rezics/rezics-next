import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { chooseOption } from '../stories/choose-option.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { spaceHref } from '../address/path.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import manageZhHans from '../manage/messages/zh-Hans.ts';
import type { ZoneAuthoringClient, ZoneNavigationClient } from './api.ts';
import { ZoneHomeEditor } from './editor.tsx';
import { ZoneEditorFrame } from './frame.tsx';
import { messages } from './messages.ts';
import { authoringModel, type EditorState } from './model.ts';
import { ZoneNavigationEditor } from './navigation-editor.tsx';
import type { NavigationState } from './navigation.ts';
import { ZoneDraftPreview } from './preview.tsx';

const zoneId = '00000000-0000-4000-8000-000000000301';
const zoneIri = `https://rezics.com/id/${zoneId}`;
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000302';
const navigation = 'https://rezics.com/id/00000000-0000-4000-8000-000000000303';
const zoneHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000304';
const variantId = 'urn:rezics:variant:00000000-0000-4000-8000-000000000305';
const epoch = '00000000-0000-4000-8000-000000000306';
const digest = 'cd'.repeat(32);
const agent = { iri: actor, label: 'Harbor editor', handle: null, kind: 'person' as const, path: 'direct-principal' as const };
const readingDirection = 'ltr' as const;
const sitePath = spaceHref(zoneId, 'site');

interface Call { name: string; key: string; expectedHead: string | null; routes?: string; navigation?: string }

function opening(document: DocumentSnapshot | null, revisionId: string | null): EditorState {
  const model = authoringModel({
    revision: zoneHead, name: 'Harbor notes', language: 'en', direction: readingDirection,
    draft: {
      variantId, revisionId, language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: readingDirection,
      document, byteDigest: revisionId ? digest : null, editable: true,
      sourcePosition: { dataEpoch: epoch, sequence: '1' },
    },
    publishedPage: null,
  }, { revision: navigation, ownerRevision: zoneHead }, zoneId, 'Harbor notes');
  if (!model) throw new Error('story fixture');
  return model.state;
}

function clientOf(calls: Call[], mode: 'save' | 'stale' | 'publish-drop'): ZoneAuthoringClient {
  let saves = 0;
  let publishes = 0;
  return {
    async saveDraft(body, key) {
      calls.push({ name: 'save', key, expectedHead: body.expectedHead });
      saves += 1;
      if (mode === 'stale' && saves === 1) return { ok: false, failure: 'stale', currentHead: '00000000-0000-4000-8000-000000000307' };
      return { ok: true, data: {
        revisionId: saves === 1 ? '00000000-0000-4000-8000-000000000308' : '00000000-0000-4000-8000-000000000309',
        byteDigest: digest, contentEpoch: epoch, replayed: false,
      } };
    },
    async publish(choice, _actingSubject, key) {
      calls.push({ name: 'publish', key, expectedHead: choice.zoneHead, routes: choice.routesRevision, navigation: choice.navigationRevision });
      publishes += 1;
      if (mode === 'publish-drop' && publishes === 1) return { ok: false, failure: 'unavailable' };
      return { ok: true, data: { zoneHead: 'https://rezics.com/id/00000000-0000-4000-8000-000000000310', replayed: false } };
    },
    async readDraft() {
      return { ok: false, failure: 'unavailable' };
    },
    async readHeads() {
      return { ok: true, data: { zoneHead, navigationRevision: navigation } };
    },
  };
}

function Page({ locale, mode, document, revisionId }: {
  locale: UiLocale; mode: 'save' | 'stale' | 'publish-drop'; document: DocumentSnapshot | null; revisionId: string | null;
}) {
  const [calls] = useState<Call[]>(() => { const found: Call[] = []; current = found; return found; });
  const [api] = useState(() => clientOf(calls, mode));
  const [initial] = useState(() => opening(document, revisionId));
  const manage = locale === 'zh-Hans' ? { ...manageMessages, ...manageZhHans } : manageMessages;
  return <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale={locale} manageMessages={manage}
    sectionsLabel={messages[locale].sectionsLabel} sectionHome={messages[locale].sectionHome} sectionNavigation={messages[locale].sectionNavigation}>
    <ZoneHomeEditor zoneId={zoneId} zoneIri={zoneIri} actingSubject={actor} locale={locale} copy={messages[locale]}
      initial={initial} editable document={document} previewHref="/manage/z/harbor/preview" siteHref={sitePath}
      signInHref="/auth/start?next=%2Fmanage%2Fz%2Fharbor" api={api} />
  </ZoneEditorFrame>;
}

let current: Call[] = [];
const noOverflow = async () => { await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth); };

/** The first line of the writing area is on screen, which is what a phone has to keep. */
async function writingInView(canvas: ReturnType<typeof within>, name: string) {
  const box = canvas.getByRole('textbox', { name });
  const top = box.getBoundingClientRect().top;
  await expect(top).toBeGreaterThanOrEqual(0);
  await expect(top).toBeLessThan(window.innerHeight);
}

const meta = { title: 'Zone editor/Home page', component: Page,
  parameters: { route: { pathname: '/en/manage/z/harbor' } },
  args: { locale: 'en' as const, mode: 'save' as const, document: null, revisionId: null } } satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

async function write(canvas: ReturnType<typeof within>, name: string, text: string) {
  const editor = await canvas.findByRole('textbox', { name });
  await userEvent.click(editor);
  await userEvent.keyboard('{Control>}a{/Control}{Backspace}');
  await userEvent.type(editor, text);
}

/** An author writes the home page and saves the first draft. Readers do not have it yet. */
export const SavesADraft: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await write(canvas, 'Home page', 'Morning edition of the harbor');
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(canvas.getByText('Draft saved.')).toBeVisible();
    await expect(current.filter(call => call.name === 'save').map(call => call.expectedHead)).toEqual([null]);
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeEnabled();
    await writingInView(canvas, 'Home page');
    await noOverflow();
  },
};

/** Another tab saved first. This tab says so and keeps what was written here. */
export const StaleSaveKeepsTheText: Story = {
  args: { mode: 'stale' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await write(canvas, 'Home page', 'A note from the other tab');
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(await canvas.findByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveTextContent('A note from the other tab');
    await userEvent.click(canvas.getByRole('button', { name: 'Save my text' }));
    await waitFor(() => expect(current.filter(call => call.name === 'save')).toHaveLength(2));
    await expect(current[1]?.expectedHead).toBe('00000000-0000-4000-8000-000000000307');
    await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveTextContent('A note from the other tab');
  },
};

/** On a phone the stale choices stack under the explanation, and both stay on the screen. */
export const StaleChoicesOnAPhone: Story = {
  globals: { viewport: { value: 'phone' } },
  render() {
    const document = fromPlainText('A note from the other tab', 'blocks');
    const initial = opening(document, '00000000-0000-4000-8000-000000000311');
    initial.notice = { kind: 'stale', currentHead: '00000000-0000-4000-8000-000000000307' };
    return <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale="en" manageMessages={manageMessages}
      sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome} sectionNavigation={messages.en.sectionNavigation}>
      <ZoneHomeEditor zoneId={zoneId} zoneIri={zoneIri} actingSubject={actor} locale="en" copy={messages.en}
        initial={initial} editable document={document} previewHref="/manage/z/harbor/preview" siteHref={sitePath}
        signInHref="/auth/start?next=%2Fmanage%2Fz%2Fharbor" api={clientOf([], 'save')} />
    </ZoneEditorFrame>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save my text' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Load the saved page' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveTextContent('A note from the other tab');
    await noOverflow();
  },
};

/** The first publish response is lost. The retry uses the same key and ends published once. */
export const LostPublishUsesTheSameKey: Story = {
  args: { mode: 'publish-drop', document: fromPlainText('Morning edition of the harbor', 'blocks'), revisionId: '00000000-0000-4000-8000-000000000311' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish' }));
    await expect(canvas.getByText('Published. Readers see this page.')).toBeVisible();
    const published = current.filter(call => call.name === 'publish');
    await expect(published).toHaveLength(2);
    await expect(published[0]?.key).toBe(published[1]?.key);
    await expect(published[0]?.routes).toBe(navigation);
    await expect(published[0]?.navigation).toBe(navigation);
    await noOverflow();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  args: { document: fromPlainText('Morning edition of the harbor', 'blocks'), revisionId: '00000000-0000-4000-8000-000000000311' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Harbor notes' })).toBeVisible();
    await writingInView(canvas, 'Home page');
    await noOverflow();
  },
};

export const SimplifiedChinesePhone: Story = {
  globals: { viewport: { value: 'phone' }, locale: 'zh-Hans' },
  parameters: { route: { pathname: '/zh-Hans/manage/z/harbor' } },
  args: { locale: 'zh-Hans', document: fromPlainText('港湾的清晨', 'blocks'), revisionId: '00000000-0000-4000-8000-000000000311' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 2, name: '首页' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '保存草稿' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: '发布' })).toBeVisible();
    await noOverflow();
  },
};

export const DraftPreview: Story = {
  globals: { viewport: { value: 'phone' } },
  render() {
    const document = fromPlainText('Morning edition of the harbor', 'blocks');
    return <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale="en" manageMessages={manageMessages}
      sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome} sectionNavigation={messages.en.sectionNavigation}>
      <ZoneDraftPreview copy={messages.en} document={document} editorPath="/manage/z/harbor" sitePath={sitePath} status="private" />
    </ZoneEditorFrame>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Draft preview' })).toBeVisible();
    await expect(canvas.getByText('Morning edition of the harbor')).toBeVisible();
    await expect(canvas.getByText(/Only people who can edit this Zone/)).toBeVisible();
    await noOverflow();
  },
};

const charts = 'https://rezics.com/id/00000000-0000-4000-8000-000000000321';
const tides = 'https://rezics.com/id/00000000-0000-4000-8000-000000000322';
let navCalls: { name: string; key: string; segment?: string }[] = [];

function navigationClient(calls: { name: string; key: string; segment?: string }[], mode: 'save' | 'stale'): ZoneNavigationClient {
  let inserts = 0;
  return {
    async readNavigation() {
      return { ok: true, data: { head: navigation, links: [] } };
    },
    async insertMount(_zone, body, key) {
      calls.push({ name: 'insert', key, segment: body.routeSegment });
      inserts += 1;
      if (mode === 'stale' && inserts === 1) return { ok: false, failure: 'stale', currentHead: null };
      return {
        ok: true, head: `https://rezics.com/id/00000000-0000-4000-8000-00000000032${inserts}`,
        occurrence: `https://rezics.com/id/00000000-0000-4000-8000-00000000033${inserts}`, replayed: false,
      };
    },
    async removeMount(_zone, _occurrence, _body, key) {
      calls.push({ name: 'remove', key });
      return { ok: true, head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000340', occurrence: null, replayed: false };
    },
    async findPages(query) {
      return query.toLowerCase().startsWith('ha')
        ? [{ target: charts, name: 'Harbor charts' }, { target: tides, name: 'Harbor tides' }] : [];
    },
  };
}

function NavigationPage({ mode }: { mode: 'save' | 'stale' }) {
  const [calls] = useState(() => { const found: { name: string; key: string; segment?: string }[] = []; navCalls = found; return found; });
  const [api] = useState(() => navigationClient(calls, mode));
  const [authoring] = useState(() => clientOf([], 'save'));
  const [home] = useState(() => opening(fromPlainText('Morning edition of the harbor', 'blocks'), '00000000-0000-4000-8000-000000000311'));
  const [initial] = useState<NavigationState>(() => ({ links: [], saved: [], head: navigation, notice: { kind: 'idle' } }));
  return <ZoneEditorFrame name="Harbor notes" editorPath="/manage/z/harbor" agent={agent} locale="en" manageMessages={manageMessages}
    sectionsLabel={messages.en.sectionsLabel} sectionHome={messages.en.sectionHome} sectionNavigation={messages.en.sectionNavigation}>
    <ZoneNavigationEditor zoneId={zoneId} zoneIri={zoneIri} actingSubject={actor} locale="en" copy={messages.en}
      initial={initial} home={home} previewHref="/manage/z/harbor/preview" siteHref={sitePath}
      signInHref="/auth/start?next=%2Fmanage%2Fz%2Fharbor" api={api} authoring={authoring} />
  </ZoneEditorFrame>;
}

async function addPage(canvas: ReturnType<typeof within>, name: string) {
  const finder = canvas.getByRole('textbox', { name: 'Page' });
  await userEvent.click(finder);
  await userEvent.keyboard('{Control>}a{/Control}{Backspace}');
  await userEvent.type(finder, 'Harbor');
  await chooseOption(canvas, name);
  await userEvent.click(canvas.getByRole('button', { name: 'Add link' }));
  await expect(canvas.getByText(name)).toBeVisible();
}

/** Two links are added, reversed, saved and published. Removing one is a later save. */
export const AddsAndReordersLinks: Story = {
  parameters: { route: { pathname: '/en/manage/z/harbor/navigation' } },
  render: () => <NavigationPage mode="save" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Navigation' })).toHaveAttribute('aria-current', 'page');
    await addPage(canvas, 'Harbor charts');
    await addPage(canvas, 'Harbor tides');
    await userEvent.click(canvas.getByRole('button', { name: 'Move up Harbor tides' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(canvas.getByText('Draft saved.')).toBeVisible();
    await expect(canvas.getByText('Publish the site for readers to see these links.')).toBeVisible();
    const inserts = navCalls.filter(call => call.name === 'insert');
    await expect(inserts.map(call => call.segment)).toEqual(['harbor-tides', 'harbor-charts']);
    await expect(inserts[1]?.key).toBe(`${inserts[0]?.key}.1`);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish' }));
    await expect(canvas.getByText('Published. Readers see this page.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Harbor charts' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(navCalls.filter(call => call.name === 'remove')).toHaveLength(1));
    await expect(canvas.queryByText('Harbor charts')).toBeNull();
    await noOverflow();
  },
};

/** A stale navigation save keeps the link the author added. */
export const StaleNavigationKeepsTheLinks: Story = {
  parameters: { route: { pathname: '/en/manage/z/harbor/navigation' } },
  render: () => <NavigationPage mode="stale" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await addPage(canvas, 'Harbor charts');
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('These links were saved somewhere else');
    await expect(canvas.getByText('Harbor charts')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Save my links' }));
    await expect(canvas.getByText('Draft saved.')).toBeVisible();
    await expect(canvas.getByText('Harbor charts')).toBeVisible();
    await noOverflow();
  },
};
