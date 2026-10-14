import { recordedHomeNavigation } from './home-authoring-recorded-inputs.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { serializeDocument } from '@rezics/document';
import { Button } from '@rezics/ui/button';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import homeRendering from '../../../../tests/qa/fixtures/outcomes/zone/home-rendering.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { browserZoneAuthoring, browserZoneTheme, type NavigationSnapshot } from './api.ts';
import { writeZoneEditorDraft, zoneEditorDraftKey } from './draft-state.ts';
import { ZoneEditorDraftProvider, useUnsavedZoneEditorSections, useZoneEditorExit } from './draft-provider.tsx';
import { ZoneHomeEditor } from './editor.tsx';
import { ZoneEditorFrame } from './frame.tsx';
import { messages } from './messages.ts';
import { authoringModel, reduceEditor, type DraftWire, type EditorState, type ZoneAuthoringModel } from './model.ts';
import { ZoneNavigationEditor } from './navigation-editor.tsx';
import { recordedActingSubject, zoneIdFromRecordedPath } from './zone-navigation-theme-recorded-page.ts';

const record = homeRendering as AnswerRecord;
function sample(label: string) {
  const found = record.personas.owner.find(item => item.label === label);
  if (!found) throw new Error(`Missing owner record: ${label}`);
  return found;
}
const editor = sample('management-editor');
const zoneId = zoneIdFromRecordedPath(editor.path);
const actingSubject = recordedActingSubject(editor.path);
const copy = messages.en;
const editorPath = `/manage/z/${zoneId}`;

/** Captured owner choices use the command records; the later editor read has another variant. */
function capturedState(state: EditorState, label: string, saved: boolean): EditorState {
  const body = sample(label).body as DraftWire;
  if (body.resourceId !== state.homeDocument) throw new Error('Recorded draft differs from the prepared home');
  const next = { ...state, variantId: body.variantId, language: body.language, direction: body.direction,
    expectedHead: body.expectedHead, value: serializeDocument(body.document), embeds: body.embeds };
  if (!saved) return reduceEditor({ ...next, value: state.value }, { type: 'edit', value: next.value });
  const answer = sample(label).answer as { revisionId: string; byteDigest: string; sourcePosition: { dataEpoch: string }; replayed: boolean };
  return reduceEditor(next, { type: 'saved', captured: next.value, savedValue: next.value,
    basis: { revisionId: answer.revisionId, byteDigest: answer.byteDigest, contentEpoch: answer.sourcePosition.dataEpoch }, replayed: answer.replayed });
}

function ExitControl() {
  const requestExit = useZoneEditorExit();
  const dirty = useUnsavedZoneEditorSections();
  const [left, setLeft] = useState(false);
  return <div data-exit-completed={left}>
    <Button disabled={!dirty.includes('home')} onClick={() => requestExit(() => setLeft(true))}>{copy.preview}</Button>
  </div>;
}

function RecordedAuthoring({ place }: { place: 'home' | 'navigation' | 'review' | 'navigation-review' | 'save' | 'exit-save' }) {
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
    const replay = recordedFetch(record, 'owner', [
      'management-editor', 'management-zone', 'management-lifecycle-configuration', 'editor-save', 'editor-publication',
    ].map(label => ({ label, state: 'populated' as const })), { pathPrefix: BFF_PREFIX });
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
        recordedHomeNavigation(main).readNavigation(zoneId, actingSubject),
      ]);
      if (showcase.error || zone.error || !navigation.ok) throw new Error('Authorized recorded editor refused');
      const model = authoringModel(showcase.data, zone.data, zoneId, 'Recorded site');
      if (!model) throw new Error('Authorized recorded model unavailable');
      const dirty = place === 'save' || place === 'exit-save';
      const state = capturedState(model.state, 'editor-save', !dirty);
      if (active) {
        if (dirty) writeZoneEditorDraft(sessionStorage, zoneEditorDraftKey(zoneId, actingSubject, 'home'), state, true);
        setLoaded({ model: { ...model, state: dirty ? model.state : state,
          document: dirty ? model.document : (sample('editor-save').body as DraftWire).document }, navigation: navigation.data, main });
      }
    }
    void load().catch(failure => { if (active) setError(failure as Error); });
    return () => { active = false; replay.dispose(); };
  }, [place]);
  if (error) throw error;
  if (!loaded) return null;
  const { model, main, navigation } = loaded;
  const home = place.endsWith('review') ? reduceEditor(model.state, { type: 'publish-stale' }) : model.state;
  const nav = place.startsWith('navigation');
  const authoring = browserZoneAuthoring(main);
  const navigationApi = recordedHomeNavigation(main);
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
      {place === 'exit-save' ? <ExitControl /> : null}
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

const save: NonNullable<Story['play']> = async context => {
  const { canvasElement } = context;
  const canvas = within(canvasElement);
  const button = await canvas.findByRole('button', { name: copy.save });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await expect(await canvas.findByText(copy.saved)).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(canvasElement.querySelector('[data-accepted-statuses]')?.getAttribute('data-accepted-statuses')?.split(','))
    .toContain('201');
};

const exitSave: NonNullable<Story['play']> = async context => {
  const canvas = within(context.canvasElement);
  await expect(await canvas.findByRole('button', { name: copy.save })).toBeEnabled();
  const preview = canvas.getByRole('button', { name: copy.preview });
  await waitFor(() => expect(preview).toBeEnabled());
  await userEvent.click(preview);
  const body = within(context.canvasElement.ownerDocument.body);
  const dialog = within(await body.findByRole('dialog', { name: copy.exitTitle }));
  await userEvent.click(dialog.getByRole('button', { name: copy.exitSave }));
  await waitFor(() => expect(context.canvasElement.querySelector('[data-exit-completed]'))
    .toHaveAttribute('data-exit-completed', 'true'));
  await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
  await expect(canvas.getByText(copy.saved)).toBeVisible();
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
export const DraftSaved: Story = { args: { place: 'save' }, play: save };
export const DraftSavedPhone: Story = { ...DraftSaved, globals: { viewport: { value: 'phone' }, locale: 'en' } };
export const SaveThenPublish: Story = { args: { place: 'save' }, async play(context) { await save(context); await publish(context); } };
export const SaveThenPublishPhone: Story = { ...SaveThenPublish, globals: { viewport: { value: 'phone' }, locale: 'en' } };
export const ExitDraftSaved: Story = { args: { place: 'exit-save' }, play: exitSave };
export const ExitDraftSavedPhone: Story = { ...ExitDraftSaved, globals: { viewport: { value: 'phone' }, locale: 'en' } };
export const ExitSaveThenPublish: Story = { args: { place: 'exit-save' }, async play(context) { await exitSave(context); await publish(context); } };
export const ExitSaveThenPublishPhone: Story = { ...ExitSaveThenPublish, globals: { viewport: { value: 'phone' }, locale: 'en' } };
