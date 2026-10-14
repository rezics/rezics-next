'use client';

import { serializeDocument } from '@rezics/document';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { RouteLoading } from '../shell/route-states.tsx';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { browserZoneAuthoring, browserZoneLifecycle, loadCompleteZoneNavigation } from './api.ts';
import { readZoneManagementFrame, type ZoneManagementFrame } from './authoring-reads.ts';
import { authoringContractClient, contractActor, contractManagementKey, contractUnsavedDocument, contractZoneId, type AuthoringContractState } from './authoring-contract.fixtures.ts';
import { ZoneEditorDraftProvider } from './draft-provider.tsx';
import { ZoneHomeEditor } from './editor.tsx';
import { ZoneEditorFrame } from './frame.tsx';
import { ZoneLifecycleEditor } from './lifecycle-editor.tsx';
import { messages } from './messages.ts';
import { ZoneDraftPreview } from './preview.tsx';
import { zoneEditorPath } from './routes.ts';
import { loadSavedPreviewFrame, type SavedPreviewFrameLoad } from './saved-preview-frame.ts';
import { ZoneSavedPreviewFrame } from './saved-preview-frame.tsx';
import { ZoneAuthoringFailure } from './states.tsx';

/** The same management and saved-preview readers as the production routes; inputs are explicitly contract-built. */
export function ZoneAuthoringContractPage({ state, view, locale }: {
  state: AuthoringContractState; view: 'manage' | 'preview'; locale: UiLocale;
}) {
  const [fixture] = useState(() => authoringContractClient(state));
  const [loaded, setLoaded] = useState<ZoneManagementFrame | null>(null);
  const [preview, setPreview] = useState<SavedPreviewFrameLoad | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const actor = contractActor(state);
  const copy = messages[locale];
  useEffect(() => {
    let active = true;
    async function load() {
      const frame = await readZoneManagementFrame(fixture.main, contractManagementKey(state), locale, actor);
      if (active) setLoaded(frame);
      if (view !== 'preview') return;
      const result = await loadSavedPreviewFrame({
        authoring: async () => frame.authoring,
        navigation: saved => loadCompleteZoneNavigation(fixture.main, contractZoneId, actor, saved.model.state),
        presentation: async () => ({ ok: false }), realmHeader: async () => ({ ok: false }), installedDigest: async () => null,
        packages: { load: async () => { throw new Error('No approved package'); }, declarations: async () => null },
      }, { locale, homeName: copy.sectionHome, lookEnabled: true });
      if (active) setPreview(result);
    }
    void load().catch((error: unknown) => { if (active) setFailure(String(error)); });
    return () => { active = false; };
  }, [fixture, actor, locale, view, copy.sectionHome]);
  let content;
  if (failure) content = <p role="alert">{failure}</p>;
  else if (view === 'preview') {
    if (!preview) content = <RouteLoading />;
    else if (preview.kind !== 'ready') content = <ZoneAuthoringFailure copy={copy}
      failure={preview.kind === 'missing' ? 'missing' : preview.failure} />;
    else {
      const { frame } = preview;
      const saved = frame.saved;
      content = <ZoneSavedPreviewFrame frame={frame} readerTheme="light"><PageContainer>
        <ZoneDraftPreview copy={copy} document={saved.model.document} editorPath={saved.editorPath} sitePath={saved.sitePath}
          status={saved.preview.publicationStatus} pageSurface={frame.cuts.tokens.pageSurface} />
      </PageContainer></ZoneSavedPreviewFrame>;
    }
  } else if (!loaded) content = <RouteLoading />;
  else {
    const ready = loaded.authoring.kind === 'ready' ? loaded.authoring : null;
    const lifecycle = loaded.lifecycle.kind === 'ready' ? loaded.lifecycle : null;
    const initial = ready?.model.state;
    const home = ready && initial ? <ZoneHomeEditor zoneId={ready.model.zoneId} zoneIri={ready.model.zoneIri}
      actingSubject={actor} locale={locale} copy={copy}
      initial={state === 'pending-save' ? { ...initial, value: serializeDocument(contractUnsavedDocument) } : initial}
      editable={ready.model.editable} document={ready.model.document} previewHref={ready.previewPath}
      siteHref={ready.sitePath} signInHref="/auth/start" api={browserZoneAuthoring(fixture.main)} />
      : <ZoneAuthoringFailure copy={copy} failure={loaded.authoring.kind === 'failure' ? loaded.authoring.failure : 'missing'} />;
    const frame = <ZoneEditorFrame name={loaded.name} editorPath={zoneEditorPath(contractZoneId)} lifecycleOnly={loaded.lifecycleOnly}
      lifecycleAddress={loaded.lifecycleAddress} agent={{ iri: actor, label: null, handle: null, kind: null, path: null }}
      locale={locale} manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel} sectionHome={copy.sectionHome}
      sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm} sectionTheme={copy.sectionTheme}
      sectionLifecycle={copy.sectionLifecycle} unsavedWork={copy.unsavedWork}>
      {loaded.lifecycleOnly && lifecycle ? <ZoneLifecycleEditor zoneId={contractZoneId} actingSubject={actor} locale={locale}
        copy={copy} initial={lifecycle} signInHref="/auth/start" returnAddress={lifecycle.returnAddress}
        api={browserZoneLifecycle(fixture.main)} /> : home}
    </ZoneEditorFrame>;
    content = loaded.draftZoneId ? <ZoneEditorDraftProvider zoneId={loaded.draftZoneId} actingSubject={actor}>{frame}</ZoneEditorDraftProvider> : frame;
  }
  return <ShellProvider locale={locale} messages={shellMessages} initialTheme="light" initialCollapsed={false}>{content}</ShellProvider>;
}
