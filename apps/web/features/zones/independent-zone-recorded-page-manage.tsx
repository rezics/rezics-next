'use client';

import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
import { serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { signInPath } from '../auth/paths.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { manager } from '../manage/server.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { parseTheme } from '../shell/preferences.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { browserZoneAuthoring, loadCompleteZoneNavigation } from '../zone-editor/api.ts';
import { ZoneEditorDraftProvider } from '../zone-editor/draft-provider.tsx';
import { zoneEditorDraftKey } from '../zone-editor/draft-state.ts';
import { ZoneHomeEditor } from '../zone-editor/editor.tsx';
import { ZoneEditorFrame } from '../zone-editor/frame.tsx';
import { ZoneSavedHomeContent } from '../zone-editor/home-content.tsx';
import { messages as editorMessages } from '../zone-editor/messages.ts';
import { ZoneDraftPreview } from '../zone-editor/preview.tsx';
import { loadZoneAuthoring, loadZoneLifecycle } from '../zone-editor/read.ts';
import { zoneEditorPath } from '../zone-editor/routes.ts';
import { loadSavedPreviewFrame, type SavedPreviewFrameLoad } from '../zone-editor/saved-preview-frame.ts';
import { ZoneSavedPreviewFrame } from '../zone-editor/saved-preview-frame.tsx';
import { ZoneAuthoringFailure } from '../zone-editor/states.tsx';
import { messages as zoneMessages } from './messages.ts';

/** A management surface the production route can reach for one recorded persona. */
export type IndependentZoneManagementPlace =
  | 'redirect' | 'manage' | 'manage-loading' | 'preview' | 'preview-loading' | 'save' | 'stale';

const signedIn = ['stranger', 'member', 'owner', 'moderator'] as const;
type SignedInPersona = (typeof signedIn)[number];

function recorded(record: AnswerRecord, persona: AnswerPersona, label: string): AnswerSample {
  const found = record.personas[persona].filter(item => item.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

function recordedState(sample: AnswerSample): RecordedSelection['state'] {
  if ([200, 201, 204].includes(sample.status)) return 'populated';
  if (sample.status >= 400 && sample.status <= 599) return 'error';
  throw new Error(`Recorded sample ${sample.label} (${sample.status}) has no story state`);
}

function isSignedIn(persona: AnswerPersona): persona is SignedInPersona {
  return (signedIn as readonly AnswerPersona[]).includes(persona);
}

function spaceOf(record: AnswerRecord, persona: AnswerPersona): string {
  const key = new URL(recorded(record, persona, 'page-address').path, 'https://recorded.invalid').searchParams.get('key');
  if (!key) throw new Error(`${persona} address has no space`);
  return key;
}

function actingOf(record: AnswerRecord, persona: SignedInPersona): AgentOption {
  const profile = recorded(record, persona, 'page-agent-profile');
  const actingSubject = new URL(profile.path, 'https://recorded.invalid').searchParams.get('actingSubject');
  const label = (profile.answer as { displayName?: unknown }).displayName;
  if (!actingSubject || typeof label !== 'string' || !label) throw new Error(`${persona} has no recorded acting name`);
  return { iri: actingSubject, label, handle: null, kind: 'person', path: 'direct-principal' };
}

/** Labels the production management and preview reads actually send. A second identical read replays the first sample. */
function visitSelections(record: AnswerRecord, persona: SignedInPersona, place: IndependentZoneManagementPlace): {
  host: readonly RecordedSelection[];
  commands: readonly RecordedSelection[];
} {
  const loading = place === 'manage-loading' || place === 'preview-loading';
  const prefix = place === 'preview' || place === 'preview-loading' ? 'saved-preview' : 'management';
  if (loading) return { host: [{ label: `${prefix}-configuration`, state: 'loading' }], commands: [] };
  const editor = recorded(record, persona, `${prefix}-editor`);
  const zone = recorded(record, persona, `${prefix}-zone`);
  const host: RecordedSelection[] = [
    { label: `${prefix}-configuration`, state: recordedState(recorded(record, persona, `${prefix}-configuration`)) },
    { label: `${prefix}-address`, state: 'populated' },
    { label: `${prefix}-site-presentation`, state: 'populated' },
    { label: `${prefix}-editor`, state: recordedState(editor) },
    { label: `${prefix}-zone`, state: recordedState(zone) },
  ];
  if (place === 'preview' && persona === 'owner') host.push({ label: 'saved-preview-navigation', state: 'populated' });
  if (place === 'save') return { host, commands: [
    { label: 'editor-save', state: 'populated' },
    { label: 'editor-publication', state: 'populated' },
  ] };
  if (place === 'stale') return { host, commands: [
    { label: 'editor-stale-save', state: 'error' },
    { label: 'editor-reopen-draft', state: 'populated' },
    { label: 'editor-reopen-heads', state: 'populated' },
  ] };
  return { host, commands: [] };
}

function savedDocument(record: AnswerRecord): string {
  const body = recorded(record, 'owner', 'editor-save').body as { document?: DocumentSnapshot };
  if (!body.document) throw new Error('editor-save has no document');
  return serializeDocument(body.document);
}

async function renderAsync(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(renderAsync));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ZoneSavedHomeContent) {
    return renderAsync(await ZoneSavedHomeContent(node.props as Parameters<typeof ZoneSavedHomeContent>[0]));
  }
  if (!('children' in node.props)) return node;
  return cloneElement(node, { children: await renderAsync(node.props.children) });
}

function EditorFrame({ name, space, agent, locale, children }: {
  name: string; space: string; agent: AgentOption; locale: UiLocale; children: ReactNode;
}) {
  const copy = editorMessages[locale];
  return <ZoneEditorFrame name={name} editorPath={zoneEditorPath(space)} agent={agent} locale={locale}
    manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel} sectionHome={copy.sectionHome}
    sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm} sectionTheme={copy.sectionTheme}
    sectionLifecycle={copy.sectionLifecycle} unsavedWork={copy.unsavedWork}>
    {children}
  </ZoneEditorFrame>;
}

function redirectTarget(error: unknown): string {
  if (error && typeof error === 'object' && 'digest' in error && typeof (error as { digest: unknown }).digest === 'string') {
    const digest = (error as { digest: string }).digest.split(';');
    if (digest[0] === 'NEXT_REDIRECT') return digest.slice(2, -2).join(';');
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Management, saved preview and the owner's reachable commands for one independent Zone.
 * The host fetch is the production site resolver; the supplied client is the editor's.
 * Save and a stale save cannot share a transport: their recorded bodies are identical.
 */
export function IndependentZoneRecordedManagement({ record, persona, place, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  place: IndependentZoneManagementPlace;
  locale: UiLocale;
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const previous = globalThis.fetch;
    setView(null);
    setProblem(null);
    const finish = (node: ReactNode) => { if (active) setView(node); };
    const fail = (error: unknown) => {
      if (!active || (error instanceof DOMException && error.name === 'AbortError')) return;
      setProblem(error instanceof Error ? error.message : String(error));
    };
    // Create the replays before the first await so cleanup always releases them.
    // Save and a stale save stay on their own transport: the recorded bodies match.
    const signed = isSignedIn(persona) ? persona : null;
    const selections = signed && place !== 'redirect' ? visitSelections(record, signed, place) : null;
    const hostReplay = signed && selections ? recordedFetch(record, signed, selections.host, { pathPrefix: BFF_PREFIX }) : null;
    const commandReplay = signed && selections && selections.commands.length
      ? recordedFetch(record, signed, selections.commands, { pathPrefix: BFF_PREFIX }) : null;
    if (place === 'redirect') {
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
        throw new Error(`visitor management sent a request: ${String(input)}`);
      }, { preconnect: globalThis.fetch.preconnect }) as unknown as typeof fetch;
    } else if (hostReplay) globalThis.fetch = hostReplay.fetcher;
    void (async () => {
      try {
        if (place === 'redirect') {
          if (persona !== 'visitor') throw new Error(`${persona} does not redirect before the editor`);
          try {
            await manager(locale, zoneEditorPath(spaceOf(record, persona)));
            throw new Error('visitor management continued into the editor');
          } catch (error) {
            if (error instanceof Error && error.message === 'visitor management continued into the editor') throw error;
            const target = redirectTarget(error);
            if (!target.includes('/auth/start')) throw error;
            finish(<p role="status">{target}</p>);
          }
          return;
        }
        if (!signed || !hostReplay) throw new Error(`${persona} has no recorded management visit`);
        const acting = actingOf(record, signed);
        const main = browserMainApi(window.location.origin, { fetcher: hostReplay.fetcher });
        const authoring = commandReplay
          ? browserZoneAuthoring(browserMainApi(window.location.origin, { fetcher: commandReplay.fetcher })) : undefined;
        const space = spaceOf(record, signed);
        const copy = editorMessages[locale];
        if (place === 'preview' || place === 'preview-loading') {
          const loaded = await loadSavedPreviewFrame({
            authoring: () => loadZoneAuthoring(main, space, locale, acting.iri),
            navigation: saved => loadCompleteZoneNavigation(main, saved.model.zoneId, acting.iri, saved.model.state),
            presentation: async () => { throw new Error('saved preview requested a public presentation'); },
            realmHeader: async () => { throw new Error('saved preview requested a realm header'); },
            installedDigest: async () => { throw new Error('saved preview requested a package digest'); },
            packages: {
              load: async slug => { throw new Error(`saved preview loaded package ${slug}`); },
              declarations: async slug => { throw new Error(`saved preview read package ${slug}`); },
            },
          }, { locale, homeName: realmMessages.home, lookEnabled: true });
          if (!active) return;
          finish(await previewView(loaded, space, acting, locale, copy));
          return;
        }
        const [loaded, lifecycle] = await Promise.all([
          loadZoneAuthoring(main, space, locale, acting.iri),
          loadZoneLifecycle(main, space, locale, acting.iri),
        ]);
        if (!active) return;
        const name = loaded.kind === 'ready' ? loaded.model.name
          : lifecycle.kind === 'ready' ? lifecycle.name : space;
        if (loaded.kind !== 'ready') {
          finish(<EditorFrame name={name} space={space} agent={acting} locale={locale}>
            <ZoneAuthoringFailure failure={loaded.kind === 'failure' ? loaded.failure : 'missing'} copy={copy} />
          </EditorFrame>);
          return;
        }
        const initial = place === 'save' || place === 'stale'
          ? { ...loaded.model.state, value: savedDocument(record) } : loaded.model.state;
        try { sessionStorage.removeItem(zoneEditorDraftKey(loaded.model.zoneId, acting.iri, 'home')); } catch { /* The route memory is enough. */ }
        finish(<EditorFrame name={name} space={space} agent={acting} locale={locale}>
          <ZoneEditorDraftProvider zoneId={loaded.model.zoneId} actingSubject={acting.iri}>
            <ZoneHomeEditor zoneId={loaded.model.zoneId} zoneIri={loaded.model.zoneIri} actingSubject={acting.iri}
              locale={locale} copy={copy} initial={initial} editable={loaded.model.editable} document={loaded.model.document}
              previewHref={loaded.previewPath} siteHref={loaded.sitePath}
              signInHref={signInPath(localizedPath(zoneEditorPath(space), locale))} api={authoring} />
          </ZoneEditorDraftProvider>
        </EditorFrame>);
      } catch (error) { fail(error); }
    })();
    return () => {
      active = false;
      globalThis.fetch = previous;
      hostReplay?.dispose();
      commandReplay?.dispose();
    };
  }, [record, persona, place, locale]);
  if (problem) return <p role="alert">{problem}</p>;
  if (!view) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  return view;
}

async function previewView(loaded: SavedPreviewFrameLoad, space: string, agent: AgentOption, locale: UiLocale,
  copy: (typeof editorMessages)[UiLocale]): Promise<ReactNode> {
  if (loaded.kind !== 'ready') {
    return <EditorFrame name={space} space={space} agent={agent} locale={locale}>
      <ZoneAuthoringFailure failure={loaded.kind === 'failure' ? loaded.failure : 'missing'} copy={copy} />
    </EditorFrame>;
  }
  const { frame } = loaded;
  const { model, preview, editorPath, sitePath } = frame.saved;
  const home = await renderAsync(<ZoneSavedHomeContent preview={preview} context={frame.context} zone={frame.zone}
    pkg={frame.pkg} messages={zoneMessages} copy={copy} />);
  return <EditorFrame name={model.name} space={space} agent={agent} locale={locale}>
    <ZoneSavedPreviewFrame frame={frame} readerTheme={parseTheme(undefined)}>
      <PageContainer>
        <ZoneDraftPreview copy={copy} document={model.document} editorPath={editorPath} sitePath={sitePath}
          status={preview.publicationStatus} pageSurface={frame.cuts.tokens.pageSurface}>
          {home}
        </ZoneDraftPreview>
      </PageContainer>
    </ZoneSavedPreviewFrame>
  </EditorFrame>;
}


