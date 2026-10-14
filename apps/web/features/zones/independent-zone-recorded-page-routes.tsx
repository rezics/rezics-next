import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import type { ManageMessages } from '../manage/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { ZoneEditorDraftProvider } from '../zone-editor/draft-provider.tsx';
import { ZoneHomeEditor } from '../zone-editor/editor.tsx';
import { ZoneEditorFrame } from '../zone-editor/frame.tsx';
import { ZoneSavedHomeContent } from '../zone-editor/home-content.tsx';
import { messages as editorMessages, type ZoneEditorMessages } from '../zone-editor/messages.ts';
import type { EditorState } from '../zone-editor/model.ts';
import { ZoneDraftPreview } from '../zone-editor/preview.tsx';
import type { ZoneAuthoringLoad, ZoneLifecycleLoad, ZoneManagementFrame } from '../zone-editor/read.ts';
import { zoneEditorPath, zoneLifecyclePath } from '../zone-editor/routes.ts';
import type { SavedPreviewFrameLoad } from '../zone-editor/saved-preview-frame.ts';
import { ZoneSavedPreviewFrame } from '../zone-editor/saved-preview-frame.tsx';
import { ZoneAuthoringFailure } from '../zone-editor/states.tsx';
import type { ZoneAuthoringClient } from '../zone-editor/api.ts';
import type { ReaderTheme } from './theme.ts';
import type { ZoneMessages } from './messages.ts';

/** The management layout. A missing Zone is not found, and the draft provider wraps the frame. */
export function zoneManagementShell({ space, frame, agent, actingSubject, locale, manageMessages, children }: {
  space: string;
  frame: ZoneManagementFrame;
  agent: AgentOption;
  actingSubject: string;
  locale: UiLocale;
  manageMessages: ManageMessages;
  children: ReactNode;
}): ReactNode {
  if (frame.missing) notFound();
  const copy = editorMessages[locale];
  const view = <ZoneEditorFrame name={frame.name} editorPath={zoneEditorPath(space)}
    lifecycleOnly={frame.lifecycleOnly} lifecycleAddress={frame.lifecycleAddress}
    agent={agent} locale={locale} manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel}
    sectionHome={copy.sectionHome} sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm}
    sectionTheme={copy.sectionTheme} sectionLifecycle={copy.sectionLifecycle} unsavedWork={copy.unsavedWork}>
    {children}
  </ZoneEditorFrame>;
  return frame.draftZoneId
    ? <ZoneEditorDraftProvider zoneId={frame.draftZoneId} actingSubject={actingSubject}>{view}</ZoneEditorDraftProvider>
    : view;
}

/**
 * The management home. A retired Zone leaves for its lifecycle page. A missing
 * draft is not found. The caller supplies the request-cached or replaying reads.
 */
export async function zoneHomeView({ space, locale, actingSubject, signInHref, loadLifecycle, loadAuthoring, initial, api }: {
  space: string;
  locale: UiLocale;
  actingSubject: string;
  signInHref: string;
  loadLifecycle: () => Promise<ZoneLifecycleLoad>;
  loadAuthoring: () => Promise<ZoneAuthoringLoad>;
  initial?: EditorState;
  api?: ZoneAuthoringClient;
}): Promise<ReactNode> {
  const copy: ZoneEditorMessages = editorMessages[locale];
  const leaveRetired = (lifecycle: ZoneLifecycleLoad) => {
    if (lifecycle.kind === 'ready' && lifecycle.status === 'retired') {
      redirect(localizedPath(zoneLifecyclePath(space, lifecycle.returnAddress), locale));
    }
  };
  leaveRetired(await loadLifecycle());
  const loaded = await loadAuthoring();
  if (loaded.kind === 'missing') {
    leaveRetired(await loadLifecycle());
    notFound();
  }
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={copy} />;
  const { model, previewPath, sitePath } = loaded;
  return <ZoneHomeEditor zoneId={model.zoneId} zoneIri={model.zoneIri} actingSubject={actingSubject} locale={locale}
    copy={copy} initial={initial ?? model.state} editable={model.editable} document={model.document}
    previewHref={previewPath} siteHref={sitePath} signInHref={signInHref} api={api} />;
}

/** The saved preview body. The caller keeps the preview's theme, nonce and package reads. */
export async function zonePreviewBody(loaded: SavedPreviewFrameLoad, { locale, readerTheme, nonce, zoneMessages }: {
  locale: UiLocale;
  readerTheme: ReaderTheme;
  nonce?: string;
  zoneMessages: ZoneMessages;
}): Promise<ReactNode> {
  if (loaded.kind === 'missing') notFound();
  if (loaded.kind === 'failure') return <ZoneAuthoringFailure failure={loaded.failure} copy={editorMessages[locale]} />;
  const { frame } = loaded;
  const { model, preview, editorPath, sitePath } = frame.saved;
  return <ZoneSavedPreviewFrame frame={frame} readerTheme={readerTheme} nonce={nonce}>
    <PageContainer>
      <ZoneDraftPreview copy={editorMessages[locale]} document={model.document} editorPath={editorPath}
        sitePath={sitePath} status={preview.publicationStatus} pageSurface={frame.cuts.tokens.pageSurface}>
        <ZoneSavedHomeContent preview={preview} context={frame.context} zone={frame.zone}
          pkg={frame.pkg} messages={zoneMessages} copy={editorMessages[locale]} />
      </ZoneDraftPreview>
    </PageContainer>
  </ZoneSavedPreviewFrame>;
}
