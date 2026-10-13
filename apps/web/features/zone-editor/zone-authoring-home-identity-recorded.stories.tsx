import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import navigationAndTheme from '../../../../tests/qa/fixtures/outcomes/zone/navigation-and-theme.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { browserZoneAuthoring, browserZoneNavigation, browserZoneTheme, type NavigationSnapshot } from './api.ts';
import { zoneEditorDraftKey } from './draft-state.ts';
import { ZoneEditorDraftProvider } from './draft-provider.tsx';
import { ZoneHomeEditor } from './editor.tsx';
import { ZoneEditorFrame } from './frame.tsx';
import { messages } from './messages.ts';
import { authoringModel, reduceEditor, type ZoneAuthoringModel } from './model.ts';
import { ZoneNavigationEditor } from './navigation-editor.tsx';
import { recordedActingSubject, zoneIdFromRecordedPath } from './zone-navigation-theme-recorded-page.ts';

const record = navigationAndTheme as AnswerRecord;
function sample(label: string) {
  const found = record.personas.owner.find(item => item.label === label);
  if (!found) throw new Error(`Missing owner record: ${label}`);
  return found;
}
const editor = sample('showcase-editor');
const zoneId = zoneIdFromRecordedPath(editor.path);
const actingSubject = recordedActingSubject(editor.path);
const copy = messages.en;
const editorPath = `/manage/z/${zoneId}`;

function RecordedAuthoring({ place }: { place: 'home' | 'navigation' | 'review' | 'navigation-review' }) {
  const [loaded, setLoaded] = useState<{
    model: ZoneAuthoringModel;
    navigation: NavigationSnapshot;
    main: ReturnType<typeof browserMainApi>;
  } | null>(null);
  const [accepted, setAccepted] = useState<number[]>([]);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    for (const section of ['home', 'navigation'] as const) {
      sessionStorage.removeItem(zoneEditorDraftKey(zoneId, actingSubject, section));
    }
    const replay = recordedFetch(record, 'owner', [{ label: 'mount-target-work', state: 'error' }, ...[
      'showcase-editor', 'draft-navigation', 'draft-navigation-editor', 'draft-configuration',
      'mount-target-collection-name', 'publish-site-bundle',
    ].map(label => ({ label, state: 'populated' as const }))], { pathPrefix: BFF_PREFIX });
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const answer = await replay.fetcher(input, init);
        if (active) setAccepted(current => [...current, answer.status]);
        return answer;
      } catch (failure) {
        if (active) setError(failure as Error);
        throw failure;
      }
    }) as typeof fetch;
    const main = browserMainApi('https://recorded.invalid', { fetcher });
    async function load() {
      const [showcase, zone, navigation] = await Promise.all([
        main.v1.zones({ id: zoneId })['showcase-editor'].get({ query: { actingSubject } }),
        main.v1.zones({ id: zoneId }).get({ query: { actingSubject } }),
        browserZoneNavigation(main).readNavigation(zoneId, actingSubject),
      ]);
      if (showcase.error || zone.error || !navigation.ok) throw new Error('Authorized recorded editor refused');
      const model = authoringModel(showcase.data, zone.data, zoneId, 'Recorded site');
      if (!model) throw new Error('Authorized recorded model unavailable');
      if (active) setLoaded({ model, navigation: navigation.data, main });
    }
    void load().catch(failure => { if (active) setError(failure as Error); });
    return () => { active = false; replay.dispose(); };
  }, []);
  if (error) throw error;
  if (!loaded) return null;
  const { model, main, navigation } = loaded;
  const home = place.endsWith('review') ? reduceEditor(model.state, { type: 'publish-stale' }) : model.state;
  const nav = place.startsWith('navigation');
  const authoring = browserZoneAuthoring(main);
  const navigationApi = browserZoneNavigation(main);
  const themeApi = browserZoneTheme(main);
  const links = navigation.links;
  return <div data-accepted-statuses={accepted.join(',')}>
    <ZoneEditorDraftProvider zoneId={zoneId} actingSubject={actingSubject}>
      <ZoneEditorFrame name={model.name} editorPath={editorPath} locale="en" manageMessages={manageMessages}
        agent={{ iri: actingSubject, label: 'Site owner', handle: null, kind: 'person', path: 'direct-principal' }}
        sectionsLabel={copy.sectionsLabel} sectionHome={copy.sectionHome} sectionNavigation={copy.sectionNavigation}
        sectionRealm={copy.sectionRealm} sectionTheme={copy.sectionTheme} unsavedWork={copy.unsavedWork}>
        {nav ? <ZoneNavigationEditor zoneId={zoneId} zoneIri={model.zoneIri} actingSubject={actingSubject}
          locale="en" copy={copy} home={home} initial={{ links, saved: links.map(link => ({ ...link })), pending: [],
            head: navigation.head, navigation: navigation.navigation, complete: navigation.complete,
            after: navigation.after, notice: { kind: 'idle' } }}
          previewHref={`${editorPath}/preview`} siteHref={`/s/${zoneId}/site`} signInHref="/sign-in"
          api={navigationApi} authoring={authoring} themeApi={themeApi} />
          : <ZoneHomeEditor zoneId={zoneId} zoneIri={model.zoneIri} actingSubject={actingSubject}
            locale="en" copy={copy} initial={home} editable={model.editable} document={model.document}
            previewHref={`${editorPath}/preview`} siteHref={`/s/${zoneId}/site`} signInHref="/sign-in"
            api={authoring} navigationApi={navigationApi} themeApi={themeApi} />}
      </ZoneEditorFrame>
    </ZoneEditorDraftProvider>
  </div>;
}

const meta = {
  title: 'Zone editor/Prepared home identity recorded',
  component: RecordedAuthoring,
  args: { place: 'home' },
  globals: { locale: 'en' },
  parameters: { route: { pathname: editorPath } },
} satisfies Meta<typeof RecordedAuthoring>;
export default meta;
type Story = StoryObj<typeof meta>;

const publish: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('heading', { level: 1, name: (editor.answer as { name: string }).name })).toBeVisible();
  const button = canvas.getByRole('button', { name: copy.publish });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await expect(await canvas.findByText(copy.published)).toBeVisible();
  if (canvas.queryByRole('heading', { name: copy.homeTitle })) await expect(canvas.getByText(copy.statusLive)).toBeVisible();
  await expect(canvasElement.querySelector('[data-accepted-statuses]')?.getAttribute('data-accepted-statuses')?.split(','))
    .toContain('201');
  await expect(button).toBeEnabled();
};

const review: NonNullable<Story['play']> = async context => {
  const canvas = within(context.canvasElement);
  const refresh = await canvas.findByRole('button', { name: copy.refreshAndPublish });
  await waitFor(() => expect(refresh).toBeEnabled());
  await userEvent.click(refresh);
  await expect(await canvas.findByRole('heading', { name: copy.publishReviewTitle })).toBeVisible();
  await expect(canvas.getByText(copy.themeCompact, { exact: false })).toBeVisible();
  const confirm = canvas.getByRole('button', { name: copy.publishReviewed });
  await expect(confirm).toBeEnabled();
  await expect(context.canvasElement.querySelector('[data-accepted-statuses]')?.getAttribute('data-accepted-statuses')?.split(','))
    .not.toContain('201');
  await userEvent.click(confirm);
  await expect(await canvas.findByText(copy.published)).toBeVisible();
  if (canvas.queryByRole('heading', { name: copy.homeTitle })) await expect(canvas.getByText(copy.statusLive)).toBeVisible();
  await expect(context.canvasElement.querySelector('[data-accepted-statuses]')?.getAttribute('data-accepted-statuses')?.split(','))
    .toContain('201');
};

export const HomePublication: Story = { args: { place: 'home' }, play: publish };
export const HomePublicationPhone: Story = { ...HomePublication, globals: { viewport: { value: 'phone' }, locale: 'en' } };
export const NavigationPublication: Story = { args: { place: 'navigation' }, play: publish };
export const NavigationPublicationPhone: Story = { ...NavigationPublication, globals: { viewport: { value: 'phone' }, locale: 'en' } };
export const ConfirmedHomeReview: Story = { args: { place: 'review' }, play: review };
export const ConfirmedHomeReviewPhone: Story = { ...ConfirmedHomeReview, globals: { viewport: { value: 'phone' }, locale: 'en' } };
export const ConfirmedNavigationReview: Story = { args: { place: 'navigation-review' }, play: review };
export const ConfirmedNavigationReviewPhone: Story = { ...ConfirmedNavigationReview, globals: { viewport: { value: 'phone' }, locale: 'en' } };
