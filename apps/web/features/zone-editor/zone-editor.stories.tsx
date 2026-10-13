import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { chooseOption } from '../stories/choose-option.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { spaceHref } from '../address/path.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import manageZhHans from '../manage/messages/zh-Hans.ts';
import type { ZoneAuthoringClient, ZoneNavigationClient, ZoneThemeClient } from './api.ts';
import { ZoneHomeEditor } from './editor.tsx';
import { ZoneEditorFrame } from './frame.tsx';
import { messages } from './messages.ts';
import { authoringModel, type EditorState } from './model.ts';
import { ZoneNavigationEditor } from './navigation-editor.tsx';
import type { NavigationState, NavPosition, SiteLink } from './navigation.ts';
import { ZoneDraftPreview } from './preview.tsx';
import { presetTokens } from '../zones/presentation.ts';
import { ZoneEditorDraftProvider } from './draft-provider.tsx';

const zoneId = '00000000-0000-4000-8000-000000000301';
const zoneIri = `https://rezics.com/id/${zoneId}`;
const homeDocument = 'https://rezics.com/id/00000000-0000-4000-8000-000000000899';
const actor = 'https://rezics.com/id/00000000-0000-4000-8000-000000000302';
const navigation = 'https://rezics.com/id/00000000-0000-4000-8000-000000000303';
const zoneHead = 'https://rezics.com/id/00000000-0000-4000-8000-000000000304';
const variantId = 'urn:rezics:variant:00000000-0000-4000-8000-000000000305';
const epoch = '00000000-0000-4000-8000-000000000306';
const digest = 'cd'.repeat(32);
const agent = {
  iri: actor,
  label: 'Harbor editor',
  handle: null,
  kind: 'person' as const,
  path: 'direct-principal' as const,
};
const readingDirection = 'ltr' as const;
const sitePath = spaceHref(zoneId, 'site');

interface Call {
  name: string;
  key: string;
  expectedHead: string | null;
  routes?: string;
  navigation?: string;
}

function opening(document: DocumentSnapshot | null, revisionId: string | null): EditorState {
  const model = authoringModel(
    {
      configuration: { homeDocument }, revision: zoneHead,
      name: 'Harbor notes',
      language: 'en',
      direction: readingDirection,
      draft: {
        variantId,
        revisionId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' },
        direction: readingDirection,
        document,
        byteDigest: revisionId ? digest : null,
        editable: true,
        sourcePosition: { dataEpoch: epoch, sequence: '1' },
      },
      publishedPage: null,
    },
    { revision: navigation, ownerRevision: zoneHead },
    zoneId,
    'Harbor notes',
  );
  if (!model) throw new Error('story fixture');
  return model.state;
}

function clientOf(calls: Call[], mode: 'save' | 'stale' | 'publish-drop' | 'publish-unresolved'): ZoneAuthoringClient {
  let saves = 0;
  let publishes = 0;
  return {
    async saveDraft(body, key) {
      calls.push({ name: 'save', key, expectedHead: body.expectedHead });
      saves += 1;
      if (mode === 'stale' && saves === 1)
        return { ok: false, failure: 'stale', currentHead: '00000000-0000-4000-8000-000000000307' };
      return {
        ok: true,
        data: {
          revisionId:
            saves === 1
              ? '00000000-0000-4000-8000-000000000308'
              : '00000000-0000-4000-8000-000000000309',
          byteDigest: digest,
          contentEpoch: epoch,
          replayed: false,
        },
      };
    },
    async publish(choice, _actingSubject, key) {
      calls.push({
        name: 'publish',
        key,
        expectedHead: choice.zoneHead,
        routes: choice.routesRevision,
        navigation: choice.navigationRevision,
      });
      publishes += 1;
      if (mode === 'publish-drop' && publishes === 1) return { ok: false, failure: 'unavailable' };
      if (mode === 'publish-unresolved' && publishes <= 2) return { ok: false, failure: 'unavailable' };
      return {
        ok: true,
        data: {
          zoneHead: 'https://rezics.com/id/00000000-0000-4000-8000-000000000310',
          replayed: false,
        },
      };
    },
    async readDraft() {
      return { ok: false, failure: 'unavailable' };
    },
    async readHeads() {
      return { ok: true, data: { zoneHead, navigationRevision: navigation } };
    },
  };
}

function Page({
  locale,
  mode,
  document,
  revisionId,
}: {
  locale: UiLocale;
  mode: 'save' | 'stale' | 'publish-drop' | 'publish-unresolved';
  document: DocumentSnapshot | null;
  revisionId: string | null;
}) {
  const [calls] = useState<Call[]>(() => {
    const found: Call[] = [];
    current = found;
    return found;
  });
  const [api] = useState(() => clientOf(calls, mode));
  const [initial] = useState(() => opening(document, revisionId));
  const manage = locale === 'zh-Hans' ? { ...manageMessages, ...manageZhHans } : manageMessages;
  return (
    <ZoneEditorFrame
      name="Harbor notes"
      editorPath="/manage/z/harbor"
      agent={agent}
      locale={locale}
      manageMessages={manage}
      sectionsLabel={messages[locale].sectionsLabel}
      sectionHome={messages[locale].sectionHome}
      sectionNavigation={messages[locale].sectionNavigation}
      sectionRealm={messages[locale].sectionRealm}
      sectionTheme={messages[locale].sectionTheme}
    >
      <ZoneHomeEditor
        zoneId={zoneId}
        zoneIri={zoneIri}
        actingSubject={actor}
        locale={locale}
        copy={messages[locale]}
        initial={initial}
        editable
        document={document}
        previewHref="/manage/z/harbor/preview"
        siteHref={sitePath}
        signInHref="/auth/start?next=%2Fmanage%2Fz%2Fharbor"
        api={api}
      />
    </ZoneEditorFrame>
  );
}

let current: Call[] = [];
const noOverflow = async () => {
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};

/** The first line of the writing area is on screen, which is what a phone has to keep. */
async function writingInView(canvas: ReturnType<typeof within>, name: string) {
  const box = canvas.getByRole('textbox', { name });
  const top = box.getBoundingClientRect().top;
  await expect(top).toBeGreaterThanOrEqual(0);
  await expect(top).toBeLessThan(window.innerHeight);
}

const meta = {
  title: 'Zone editor/Home page',
  component: Page,
  parameters: { route: { pathname: '/en/manage/z/harbor' } },
  args: { locale: 'en' as const, mode: 'save' as const, document: null, revisionId: null },
} satisfies Meta<typeof Page>;
export default meta;
type Story = StoryObj<typeof meta>;

async function write(canvas: ReturnType<typeof within>, name: string, text: string) {
  const editor = await canvas.findByRole('textbox', { name });
  await userEvent.click(editor);
  await userEvent.keyboard('{Control>}a{/Control}{Backspace}');
  await userEvent.type(editor, text, { delay: 10 });
}

/** An author writes the home page and saves the first draft. Readers do not have it yet. */
export const SavesADraft: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await write(canvas, 'Home page', 'Morning edition of the harbor');
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(canvas.getByText('Draft saved.')).toBeVisible();
    await expect(
      current.filter((call) => call.name === 'save').map((call) => call.expectedHead),
    ).toEqual([null]);
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
    await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveTextContent(
      'A note from the other tab',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Save my text' }));
    await waitFor(() => expect(current.filter((call) => call.name === 'save')).toHaveLength(2));
    await expect(current[1]?.expectedHead).toBe('00000000-0000-4000-8000-000000000307');
    await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveTextContent(
      'A note from the other tab',
    );
  },
};

export const CleanHomeRetainsAnUnresolvedPublicationOnExit: Story = {
  args: { mode: 'publish-unresolved', document: fromPlainText('Saved harbor home', 'blocks'),
    revisionId: '00000000-0000-4000-8000-000000000311' },
  render(args) {
    return <ZoneEditorDraftProvider zoneId={zoneId} actingSubject={actor}><Page {...args} /></ZoneEditorDraftProvider>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /^Publish$/ }));
    await waitFor(() => expect(current).toHaveLength(2));
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    await expect(unload.defaultPrevented).toBe(true);
    await userEvent.click(canvas.getByRole('link', { name: /^Preview$/ }));
    const screen = within(document.body);
    await expect(await screen.findByRole('dialog')).toHaveTextContent('Save your unsaved work before leaving?');
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(current).toHaveLength(3));
    await expect(current[2]).toEqual(current[0]);
    await expect(await canvas.findByText(/^Published\./)).toBeVisible();
  },
};

/** On a phone the stale choices stack under the explanation, and both stay on the screen. */
export const StaleChoicesOnAPhone: Story = {
  globals: { viewport: { value: 'phone' } },
  render() {
    const document = fromPlainText('A note from the other tab', 'blocks');
    const initial = opening(document, '00000000-0000-4000-8000-000000000311');
    initial.notice = { kind: 'stale', currentHead: '00000000-0000-4000-8000-000000000307' };
    return (
      <ZoneEditorFrame
        name="Harbor notes"
        editorPath="/manage/z/harbor"
        agent={agent}
        locale="en"
        manageMessages={manageMessages}
        sectionsLabel={messages.en.sectionsLabel}
        sectionHome={messages.en.sectionHome}
        sectionNavigation={messages.en.sectionNavigation}
        sectionRealm={messages.en.sectionRealm}
        sectionTheme={messages.en.sectionTheme}
      >
        <ZoneHomeEditor
          zoneId={zoneId}
          zoneIri={zoneIri}
          actingSubject={actor}
          locale="en"
          copy={messages.en}
          initial={initial}
          editable
          document={document}
          previewHref="/manage/z/harbor/preview"
          siteHref={sitePath}
          signInHref="/auth/start?next=%2Fmanage%2Fz%2Fharbor"
          api={clientOf([], 'save')}
        />
      </ZoneEditorFrame>
    );
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Save my text' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Load the saved page' })).toBeVisible();
    await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveTextContent(
      'A note from the other tab',
    );
    await noOverflow();
  },
};

let finishSavedPageLoad: (() => void) | undefined;

/** The destructive read suspends writing until its selected saved page arrives. */
export const DelayedSavedPageLoadKeepsTypingSafe: Story = {
  render() {
    const document = fromPlainText('Local unsaved paragraph', 'blocks');
    const initial = opening(document, '00000000-0000-4000-8000-000000000311');
    initial.notice = { kind: 'stale', currentHead: '00000000-0000-4000-8000-000000000307' };
    const api = clientOf([], 'save');
    api.readDraft = () => new Promise(resolve => {
      finishSavedPageLoad = () => resolve({ ok: true, data: {
        ...initial, value: opening(fromPlainText('Server saved paragraph', 'blocks'), initial.expectedHead).value,
        editable: true, document: fromPlainText('Server saved paragraph', 'blocks'),
      } });
    });
    return <main className="mx-auto max-w-3xl p-6">
      <ZoneHomeEditor zoneId={zoneId} zoneIri={zoneIri} actingSubject={actor} locale="en" copy={messages.en}
        initial={initial} editable document={document} previewHref="/manage/z/harbor/preview"
        siteHref={sitePath} signInHref="/auth/start" api={api} />
    </main>;
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Load the saved page' }));
    const body = canvas.getByRole('textbox', { name: 'Home page' });
    await expect(body).toHaveAttribute('contenteditable', 'false');
    await userEvent.click(body);
    await userEvent.keyboard('Typing during the saved-page load');
    await expect(body).toHaveTextContent('Local unsaved paragraph');
    finishSavedPageLoad?.();
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveTextContent('Server saved paragraph'));
    await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveAttribute('contenteditable', 'true');
    await userEvent.click(canvas.getByRole('textbox', { name: 'Home page' }));
    await userEvent.keyboard(' New typing after load');
    await expect(canvas.getByRole('textbox', { name: 'Home page' })).toHaveTextContent('New typing after load');
  },
};

/** The first publish response is lost. The retry uses the same key and ends published once. */
export const LostPublishUsesTheSameKey: Story = {
  args: {
    mode: 'publish-drop',
    document: fromPlainText('Morning edition of the harbor', 'blocks'),
    revisionId: '00000000-0000-4000-8000-000000000311',
  },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish' }));
    await expect(canvas.getByText('Published. Readers see this page.')).toBeVisible();
    const published = current.filter((call) => call.name === 'publish');
    await expect(published).toHaveLength(2);
    await expect(published[0]?.key).toBe(published[1]?.key);
    await expect(published[0]?.routes).toBe(navigation);
    await expect(published[0]?.navigation).toBe(navigation);
    await noOverflow();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  args: {
    document: fromPlainText('Morning edition of the harbor', 'blocks'),
    revisionId: '00000000-0000-4000-8000-000000000311',
  },
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
  args: {
    locale: 'zh-Hans',
    document: fromPlainText('港湾的清晨', 'blocks'),
    revisionId: '00000000-0000-4000-8000-000000000311',
  },
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
    return (
      <ZoneEditorFrame
        name="Harbor notes"
        editorPath="/manage/z/harbor"
        agent={agent}
        locale="en"
        manageMessages={manageMessages}
        sectionsLabel={messages.en.sectionsLabel}
        sectionHome={messages.en.sectionHome}
        sectionNavigation={messages.en.sectionNavigation}
        sectionRealm={messages.en.sectionRealm}
        sectionTheme={messages.en.sectionTheme}
      >
        <ZoneDraftPreview
          copy={messages.en}
          document={document}
          editorPath="/manage/z/harbor"
          sitePath={sitePath}
          status="private"
        />
      </ZoneEditorFrame>
    );
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
let navServer: SiteLink[] = [];

type NavigationMode = 'save' | 'stale' | 'stale-removal' | 'partial' | 'incomplete' | 'paths'
  | 'review-denied' | 'review-unavailable' | 'review-stale' | 'publish-unresolved';
const navigationPublicationCalls: Call[] = [];
const loadedMounts: SiteLink[] = [
  {
    id: '00000000-0000-4000-8000-000000000351',
    occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000351',
    target: charts,
    name: 'Harbor charts',
    segment: 'harbor-charts',
    disclosure: 'public',
  },
  {
    id: '00000000-0000-4000-8000-000000000352',
    occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000352',
    target: tides,
    name: 'Harbor tides',
    segment: 'harbor-tides',
    disclosure: 'public',
  },
];
const unsavedMount: SiteLink = {
  id: 'new-soundings',
  occurrence: null,
  target: 'https://rezics.com/id/00000000-0000-4000-8000-000000000353',
  name: 'Harbor soundings',
  segment: 'harbor-soundings',
  disclosure: 'public',
};
const continuedMount: SiteLink = {
  ...unsavedMount,
  id: '00000000-0000-4000-8000-000000000354',
  occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000354',
};
const replacementMount: SiteLink = {
  ...loadedMounts[0]!,
  id: '00000000-0000-4000-8000-000000000355',
  occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000355',
  name: 'Replacement harbor charts',
  disclosure: 'private',
  routeKey: 'alias',
  presentation: 'https://rezics.com/definition/harbor-presentation',
};

function navigationClient(
  calls: { name: string; key: string; segment?: string }[],
  mode: NavigationMode,
): ZoneNavigationClient {
  let inserts = 0;
  let removes = 0;
  if (mode === 'paths') navServer = loadedMounts.map((link) => ({ ...link }));
  function placeServer(link: SiteLink, position: NavPosition) {
    navServer = navServer.filter((item) => item.occurrence !== link.occurrence);
    const at =
      position === 'first'
        ? 0
        : position === 'last'
          ? navServer.length
          : navServer.findIndex((item) => item.occurrence === position.after) + 1;
    navServer.splice(at, 0, link);
  }
  return {
    async readNavigation() {
      calls.push({ name: 'read', key: '' });
      if (mode === 'stale' || mode === 'stale-removal')
        return {
          ok: true,
          data: {
            head: navigation,
            navigation,
            links: mode === 'stale-removal' ? [replacementMount] : [],
            complete: false,
            after: 'cursor:recovery',
            zoneHead: null,
          },
        };
      return {
        ok: true,
        data: {
          head: navigation,
          navigation,
          links: mode === 'paths' ? navServer : [],
          complete: true,
          after: null,
          zoneHead: null,
        },
      };
    },
    async continueNavigation(_zone, _actingSubject, resume) {
      calls.push({ name: 'continue', key: '' });
      if (mode === 'stale' || mode === 'stale-removal') {
        if (resume.head !== navigation || resume.after !== 'cursor:recovery')
          throw new Error('Recovery must continue the pinned head');
      }
      return {
        ok: true,
        data: {
          head: navigation,
          navigation,
          links:
            mode === 'stale-removal'
              ? [loadedMounts[1]!]
              : mode === 'incomplete' || mode === 'stale'
                ? [continuedMount]
                : [],
          complete: true,
          after: null,
          zoneHead: null,
        },
      };
    },
    async insertMount(_zone, body, key) {
      calls.push({ name: 'insert', key, segment: body.routeSegment });
      inserts += 1;
      if (mode === 'stale' && inserts === 1)
        return { ok: false, failure: 'stale', currentHead: null };
      if (mode === 'partial' && inserts <= 2) return { ok: false, failure: 'unavailable' };
      const occurrence = `https://rezics.com/id/00000000-0000-4000-8000-00000000033${inserts}`;
      if (mode === 'paths')
        placeServer(
          {
            ...unsavedMount,
            id: occurrence.slice(-36),
            occurrence,
            target: body.target,
            segment: body.routeSegment,
            disclosure: body.disclosure,
          },
          body.position,
        );
      return {
        ok: true,
        head: `https://rezics.com/id/00000000-0000-4000-8000-00000000032${inserts}`,
        occurrence,
        replayed: false,
      };
    },
    async removeMount(_zone, _occurrence, _body, key) {
      calls.push({ name: 'remove', key });
      removes += 1;
      if (mode === 'stale-removal' && removes === 1)
        return { ok: false, failure: 'stale', currentHead: navigation };
      return {
        ok: true,
        head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000340',
        occurrence: null,
        replayed: false,
      };
    },
    async moveMount(_navigation, body, key) {
      calls.push({ name: 'move', key });
      if (mode === 'paths') {
        const mounted = navServer.find((item) => item.occurrence === body.occurrence);
        if (!mounted) throw new Error('Only existing occurrences may move');
        placeServer(mounted, body.position);
      }
      return {
        ok: true,
        head: 'https://rezics.com/id/00000000-0000-4000-8000-000000000341',
        occurrence: null,
        replayed: false,
      };
    },
    async findPages(query) {
      return { ok: true, data: { choices: query.toLowerCase().startsWith('ha')
        ? [
            { target: charts, name: 'Harbor charts' },
            { target: tides, name: 'Harbor tides' },
            ...(mode === 'paths' ? [{ target: unsavedMount.target, name: unsavedMount.name }] : []),
          ]
        : [], hasMore: false } };
    },
  };
}

function NavigationPage({ mode }: { mode: NavigationMode }) {
  const [calls] = useState(() => {
    const found: { name: string; key: string; segment?: string }[] = [];
    navCalls = found;
    return found;
  });
  const [api] = useState(() => navigationClient(calls, mode));
  const [authoring] = useState(() => {
    navigationPublicationCalls.length = 0;
    return clientOf(navigationPublicationCalls, mode === 'publish-unresolved' ? mode : 'save');
  });
  const [themeApi] = useState<ZoneThemeClient>(() => ({
    async readConfiguration() {
      return { ok: true, data: { revision: zoneHead, configuration: { homeDocument, presentation: {
        profile: 'zone-presentation-v2', preset: 'clean', tokens: presetTokens.clean, navigation: [], modules: [], slides: [],
      } } } };
    },
    async saveConfiguration() { return { ok: false, failure: 'unavailable' }; },
  }));
  if (mode.startsWith('review-')) {
    authoring.readHeads = async () => mode === 'review-denied' ? { ok: false, failure: 'denied' }
      : mode === 'review-unavailable' ? { ok: false, failure: 'unavailable' }
      : { ok: true, data: { zoneHead, navigationRevision: navigation } };
    authoring.publish = async () => ({ ok: false, failure: 'stale', currentHead: zoneHead });
    api.readNavigation = async () => ({ ok: true, data: {
      head: navigation, navigation, links: [], complete: true, after: null, zoneHead,
    } });
  }
  const [home] = useState(() =>
    opening(
      fromPlainText('Morning edition of the harbor', 'blocks'),
      '00000000-0000-4000-8000-000000000311',
    ),
  );
  const [initial] = useState<NavigationState>(() => {
    const base: NavigationState = {
      links: [],
      saved: [],
      pending: [],
      head: navigation,
      navigation,
      complete: true,
      after: null,
      notice: { kind: 'idle' },
    };
    if (mode === 'partial')
      return {
        ...base,
        saved: loadedMounts,
        links: [loadedMounts[1]!, unsavedMount],
        pending: [
          { kind: 'remove', occurrence: loadedMounts[0]!.occurrence!, name: loadedMounts[0]!.name },
          { kind: 'add', link: unsavedMount, position: 1 },
        ],
      };
    if (mode === 'incomplete')
      return {
        ...base,
        links: loadedMounts,
        saved: loadedMounts,
        complete: false,
        after: 'cursor:2',
      };
    if (mode === 'stale-removal' || mode === 'paths')
      return { ...base, links: loadedMounts, saved: loadedMounts };
    return base;
  });
  if (mode.startsWith('review-')) { home.notice = { kind: 'publish-stale' }; initial.notice = { kind: 'review', dropped: [] }; }
  return (
    <ZoneEditorFrame
      name="Harbor notes"
      editorPath="/manage/z/harbor"
      agent={agent}
      locale="en"
      manageMessages={manageMessages}
      sectionsLabel={messages.en.sectionsLabel}
      sectionHome={messages.en.sectionHome}
      sectionNavigation={messages.en.sectionNavigation}
      sectionRealm={messages.en.sectionRealm}
      sectionTheme={messages.en.sectionTheme}
    >
      <ZoneNavigationEditor
        zoneId={zoneId}
        zoneIri={zoneIri}
        actingSubject={actor}
        locale="en"
        copy={messages.en}
        initial={initial}
        home={home}
        previewHref="/manage/z/harbor/preview"
        siteHref={sitePath}
        signInHref="/auth/start?next=%2Fmanage%2Fz%2Fharbor"
        api={api}
        authoring={authoring}
        themeApi={themeApi}
      />
    </ZoneEditorFrame>
  );
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

export const DeniedPublicationReviewRemainsVisibleBesideNavigation: Story = {
  render: () => <NavigationPage mode="review-denied" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: messages.en.refreshAndPublish }));
    await expect(await canvas.findByText(messages.en.deniedBody)).toBeVisible();
    await expect(canvas.getByText(messages.en.navReviewClean)).toBeVisible();
  },
};

export const CleanNavigationRetainsAnUnresolvedPublicationOnExit: Story = {
  render: () => <ZoneEditorDraftProvider zoneId={zoneId} actingSubject={actor}>
    <NavigationPage mode="publish-unresolved" />
  </ZoneEditorDraftProvider>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /^Publish$/ }));
    await waitFor(() => expect(navigationPublicationCalls).toHaveLength(2));
    await userEvent.click(canvas.getByRole('link', { name: /^Preview$/ }));
    const screen = within(document.body);
    await expect(await screen.findByRole('dialog')).toHaveTextContent('Save your unsaved work before leaving?');
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(navigationPublicationCalls).toHaveLength(3));
    await expect(navigationPublicationCalls[2]).toEqual(navigationPublicationCalls[0]);
    await expect(await canvas.findByText(/^Published\./)).toBeVisible();
  },
};

export const UnavailablePublicationReviewOffersRetry: Story = {
  render: () => <NavigationPage mode="review-unavailable" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: messages.en.refreshAndPublish }));
    await expect(await canvas.findByText(messages.en.unavailableBody)).toBeVisible();
    await expect(canvas.getByRole('button', { name: messages.en.tryAgain })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: messages.en.tryAgain }));
    await expect(canvas.getByText(messages.en.unavailableBody)).toBeVisible();
  },
};

export const ReviewedPublicationCanBecomeStaleAgain: Story = {
  render: () => <NavigationPage mode="review-stale" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: messages.en.refreshAndPublish }));
    await userEvent.click(await canvas.findByRole('button', { name: messages.en.publishReviewed }));
    await expect(await canvas.findByRole('button', { name: messages.en.refreshAndPublish })).toBeEnabled();
    await expect(canvas.getByText(messages.en.navReviewClean)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: messages.en.refreshAndPublish }));
    await expect(await canvas.findByRole('button', { name: messages.en.publishReviewed })).toBeEnabled();
  },
};

function NavigationPathSections() {
  const [visible, setVisible] = useState(true);
  return <ZoneEditorDraftProvider zoneId="path-validation" actingSubject={actor}>
    <nav className="flex gap-2 p-3">
      <button onClick={() => setVisible(false)}>Leave Navigation section</button>
      <button onClick={() => setVisible(true)}>Return to Navigation section</button>
    </nav>
    {visible ? <NavigationPage mode="paths" /> : <p>Home section</p>}
  </ZoneEditorDraftProvider>;
}

export const InvalidAndDuplicatePathsBlockSavingAcrossSections: Story = {
  render: () => <NavigationPathSections />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await addPage(canvas, 'Harbor soundings');
    const field = canvas.getByRole('textbox', { name: 'Path Harbor soundings' });
    await userEvent.clear(field);
    await userEvent.type(field, 'Invalid Path!');
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Leave Navigation section' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Return to Navigation section' }));
    const restored = canvas.getByRole('textbox', { name: 'Path Harbor soundings' });
    await expect(restored).toHaveValue('Invalid Path!');
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await userEvent.clear(restored);
    await userEvent.type(restored, 'harbor-charts');
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await userEvent.clear(restored);
    await userEvent.type(restored, 'new-soundings');
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    await expect(navCalls).toHaveLength(0);
  },
};

/** Two links are added, reversed, saved and published. Removing one is a later save. */
export const AddsAndReordersLinks: Story = {
  parameters: { route: { pathname: '/en/manage/z/harbor/navigation' } },
  render: () => <NavigationPage mode="save" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Navigation' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await addPage(canvas, 'Harbor charts');
    await addPage(canvas, 'Harbor tides');
    await userEvent.click(canvas.getByRole('button', { name: 'Move up Harbor tides' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(canvas.getByText('Draft saved.')).toBeVisible();
    await expect(
      canvas.getByText('Publish the site for readers to see these links.'),
    ).toBeVisible();
    const inserts = navCalls.filter((call) => call.name === 'insert');
    await expect(inserts.map((call) => call.segment)).toEqual(['harbor-tides', 'harbor-charts']);
    await expect(inserts[1]?.key).toBe(`${inserts[0]?.key}.1`);
    await userEvent.click(canvas.getByRole('button', { name: 'Publish' }));
    await expect(canvas.getByText('Published. Readers see this page.')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Harbor charts' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(navCalls.filter((call) => call.name === 'remove')).toHaveLength(1));
    await expect(canvas.queryByText('Harbor charts')).toBeNull();
    await noOverflow();
  },
};

/** Saved paths remain the server’s paths; a new link’s edited path is acknowledged when saved. */
export const SavedPathsStayReadOnlyWhenReordering: Story = {
  parameters: { route: { pathname: '/en/manage/z/harbor/navigation' } },
  render: () => <NavigationPage mode="paths" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    for (const item of loadedMounts) {
      const field = canvas.getByRole('textbox', { name: `Path ${item.name}` });
      await expect(field).toHaveAttribute('readonly');
      await expect(field).toHaveAccessibleDescription(messages.en.pathEditLimited);
      await userEvent.click(field);
      await userEvent.keyboard('{Control>}a{/Control}{Backspace}');
      await userEvent.type(field, `changed-${item.segment}`);
      await expect(field).toHaveValue(item.segment);
    }
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await expect(canvas.queryByText('Draft saved.')).toBeNull();
    await expect(navCalls).toHaveLength(0);
    await addPage(canvas, 'Harbor soundings');
    const newPath = canvas.getByRole('textbox', { name: 'Path Harbor soundings' });
    await expect(newPath).not.toHaveAttribute('readonly');
    await userEvent.clear(newPath);
    await userEvent.type(newPath, 'new-soundings-path');
    await expect(newPath).toHaveValue('new-soundings-path');
    await userEvent.click(canvas.getByRole('button', { name: 'Move up Harbor tides' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Move up Harbor soundings' }));
    await expect(canvas.queryByText('Draft saved.')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(await canvas.findByText('Draft saved.')).toBeVisible();
    await expect(navServer.map((item) => item.segment)).toEqual([
      'harbor-tides',
      'new-soundings-path',
      'harbor-charts',
    ]);
    const links = within(canvas.getByRole('list', { name: 'Links' }));
    await expect(
      links.getAllByRole('textbox').map((field) => (field as HTMLInputElement).value),
    ).toEqual(navServer.map((item) => item.segment));
    for (const item of navServer) {
      await expect(canvas.getByRole('textbox', { name: `Path ${item.name}` })).toHaveAttribute(
        'readonly',
      );
    }
    await expect(navServer.find((item) => item.target === charts)).toEqual(loadedMounts[0]);
    await expect(navServer.find((item) => item.target === tides)).toEqual(loadedMounts[1]);
    await expect(navCalls.map((call) => call.name)).toEqual(['move', 'insert']);
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await noOverflow();
  },
};

/** A stale save loads every current link and leaves the retained addition for author review. */
export const StaleNavigationKeepsTheLinks: Story = {
  parameters: { route: { pathname: '/en/manage/z/harbor/navigation' } },
  render: () => <NavigationPage mode="stale" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await addPage(canvas, 'Harbor charts');
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent(messages.en.navReview));
    await expect(canvas.getByText('Harbor charts')).toBeVisible();
    await expect(canvas.getByText('Harbor soundings')).toBeVisible();
    await expect(navCalls.filter((call) => call.name === 'read')).toHaveLength(1);
    await expect(navCalls.filter((call) => call.name === 'continue')).toHaveLength(1);
    await expect(navCalls.filter((call) => call.name === 'insert')).toHaveLength(1);
    await expect(canvas.queryByRole('button', { name: 'Load more links' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(await canvas.findByText('Draft saved.')).toBeVisible();
    await expect(navCalls.filter((call) => call.name === 'insert')).toHaveLength(2);
    await expect(canvas.getByText('Harbor charts')).toBeVisible();
    await noOverflow();
  },
};

/** The removed occurrence is reported; another editor’s matching replacement stays untouched. */
export const StaleRemovalReportsTheMissingLink: Story = {
  parameters: { route: { pathname: '/en/manage/z/harbor/navigation' } },
  render: () => <NavigationPage mode="stale-removal" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Harbor charts' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(canvas.getByRole('alert')).toHaveTextContent(messages.en.navReviewClean),
    );
    await expect(canvas.getByRole('alert')).toHaveTextContent(messages.en.navDropped);
    await expect(canvas.getByRole('alert')).toHaveTextContent('Remove: Harbor charts');
    await expect(canvas.getByText('Replacement harbor charts')).toBeVisible();
    await expect(
      canvas.getByRole('textbox', { name: 'Path Replacement harbor charts' }),
    ).toHaveValue('harbor-charts');
    await expect(canvas.getByText('Harbor tides')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Load more links' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: 'Remove Replacement harbor charts' }),
    ).toBeEnabled();
    await expect(navCalls.map((call) => call.name)).toEqual(['remove', 'read', 'continue']);
    await noOverflow();
  },
};

/** An acknowledged removal is kept while the unfinished insertion resumes under its original key. */
export const PartlySavedNavigationResumes: Story = {
  parameters: { route: { pathname: '/en/manage/z/harbor/navigation' } },
  render: () => <NavigationPage mode="partial" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(await canvas.findByText('Changes saved: 1')).toBeVisible();
    const resume = await canvas.findByRole('button', { name: 'Resume saving' });
    await expect(resume).toBeEnabled();
    await expect(
      canvas.getByText(
        'Some changes are saved. Resume saving to finish the rest before publishing.',
      ),
    ).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Remove Harbor tides' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Move up Harbor soundings' })).toBeDisabled();
    await expect(canvas.getByRole('textbox', { name: 'Path Harbor soundings' })).toBeDisabled();
    await expect(canvas.getByRole('textbox', { name: 'Page' })).toBeDisabled();
    await expect(navCalls.filter((call) => call.name === 'remove')).toHaveLength(1);
    const firstAttempts = navCalls.filter((call) => call.name === 'insert');
    await expect(firstAttempts).toHaveLength(2);
    await expect(firstAttempts[0]!.key).toBe(firstAttempts[1]!.key);
    await userEvent.click(resume);
    await expect(await canvas.findByText('Draft saved.')).toBeVisible();
    await expect(navCalls.filter((call) => call.name === 'remove')).toHaveLength(1);
    const allAttempts = navCalls.filter((call) => call.name === 'insert');
    await expect(allAttempts).toHaveLength(3);
    await expect(allAttempts[2]!.key).toBe(firstAttempts[0]!.key);
    await expect(canvas.getByRole('button', { name: 'Remove Harbor soundings' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeEnabled();
    await noOverflow();
  },
};

/** The author loads all links by keyboard before changing their order. */
export const CompleteNavigationBeforeEditing: Story = {
  parameters: { route: { pathname: '/en/manage/z/harbor/navigation' } },
  render: () => <NavigationPage mode="incomplete" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(messages.en.navIncomplete)).toBeVisible();
    for (const control of canvas.getAllByRole('button', {
      name: /^(Move up|Move down|Remove) Harbor/,
    })) {
      await expect(control).toBeDisabled();
    }
    await expect(canvas.getByRole('textbox', { name: 'Path Harbor charts' })).toBeDisabled();
    await expect(canvas.getByRole('textbox', { name: 'Path Harbor tides' })).toBeDisabled();
    await expect(canvas.getByRole('textbox', { name: 'Page' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Add link' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeDisabled();
    const loadMore = canvas.getByRole('button', { name: 'Load more links' });
    await expect(loadMore).toBeEnabled();
    loadMore.focus();
    await expect(loadMore).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(await canvas.findByText('Harbor soundings')).toBeVisible();
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: 'Move up Harbor tides' })).toBeEnabled(),
    );
    await expect(canvas.getByRole('textbox', { name: 'Path Harbor charts' })).toBeEnabled();
    await expect(canvas.getByRole('textbox', { name: 'Page' })).toBeEnabled();
    await expect(canvas.queryByText(messages.en.navIncomplete)).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Move up Harbor tides' }));
    const links = within(canvas.getByRole('list', { name: 'Links' }));
    await expect(
      links
        .getAllByRole('button', { name: /^Move up Harbor/ })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Move up Harbor tides', 'Move up Harbor charts', 'Move up Harbor soundings']);
    await expect(canvas.getByRole('button', { name: 'Save draft' })).toBeEnabled();
    await expect(canvas.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(await canvas.findByText('Draft saved.')).toBeVisible();
    await expect(navCalls.filter((call) => call.name === 'continue')).toHaveLength(1);
    await expect(navCalls.filter((call) => call.name === 'move')).toHaveLength(1);
    await expect(
      navCalls.filter((call) => call.name === 'remove' || call.name === 'insert'),
    ).toHaveLength(0);
    await noOverflow();
  },
};
