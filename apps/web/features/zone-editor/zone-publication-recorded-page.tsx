'use client';

import { useEffect, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { messages as manageMessages } from '../manage/messages.ts';
import manageDe from '../manage/messages/de.ts';
import { RouteLoading } from '../shell/route-states.tsx';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { ZoneSiteRecordedPage } from '../zones/zone-site-recorded-page.tsx';
import { readZoneManagementFrame, type ZoneManagementFrame } from './authoring-reads.ts';
import { ZoneEditorDraftProvider } from './draft-provider.tsx';
import { ZoneHomeEditor } from './editor.tsx';
import { ZoneEditorFrame } from './frame.tsx';
import { messages as zoneMessages } from './messages.ts';
import { zoneEditorPath } from './routes.ts';
import { ZoneAuthoringFailure } from './states.tsx';
import { managementVisit, recordedActingPerson } from './zone-publication-recorded-page.ts';

/** One persona's recorded publication page. The site frame is the public cut. */
export function ZonePublicationRecordedPage({ record, persona, selections, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
}) {
  const acting = recordedActingPerson(record, persona, selections);
  return <section aria-label={persona} className="grid min-w-0 gap-2">
    <p className="px-4 pt-3 text-sm text-muted-foreground sm:px-6 lg:px-10">{persona}</p>
    {acting ? <p className="break-all px-4 text-sm text-muted-foreground sm:px-6 lg:px-10">{acting}</p> : null}
    <ZoneSiteRecordedPage record={record} persona={persona} selections={selections} locale={locale} />
  </section>;
}

type ManagementView = { kind: 'loading' } | { kind: 'discrepancy'; detail: string } | { kind: 'frame'; frame: ZoneManagementFrame };

/**
 * The management route: the layout's authoring and lifecycle reads, then the frame those reads decide.
 * A held configuration request stays on the route loading state.
 */
export function ZonePublicationManagementPage({ record, persona, selections, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
}) {
  const visit = managementVisit(record, persona, selections);
  const [view, setView] = useState<ManagementView>({ kind: 'loading' });
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher });
    void readZoneManagementFrame(main, visit.space, locale, visit.actingSubject).then(loaded => {
      if (mounted) setView({ kind: 'frame', frame: loaded });
    }).catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setView({ kind: 'discrepancy', detail: error instanceof Error ? error.message : String(error) });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, selections, locale, visit.space, visit.actingSubject]);
  const copy = zoneMessages[locale];
  const manage = locale === 'de' ? { ...manageMessages, ...manageDe } : manageMessages;
  // The configuration query names this Person. The management reads do not return an Agent profile.
  const agent = { iri: visit.actingSubject, label: null, handle: null, kind: null, path: null };
  const settled = view.kind === 'frame' ? view.frame : null;
  const authoring = settled?.authoring ?? null;
  const ready = authoring?.kind === 'ready' ? authoring : null;
  const failure = view.kind === 'discrepancy' ? <p role="alert">{view.detail}</p>
    : authoring?.kind === 'missing' ? <ZoneAuthoringFailure failure="missing" copy={copy} />
    : authoring?.kind === 'failure' ? <ZoneAuthoringFailure failure={authoring.failure} copy={copy} />
    : null;
  const frame = view.kind === 'loading' ? null : <ZoneEditorFrame
    name={settled?.name ?? visit.space} editorPath={zoneEditorPath(visit.space)}
    lifecycleOnly={settled?.lifecycleOnly ?? false} lifecycleAddress={settled?.lifecycleAddress}
    agent={agent} locale={locale} manageMessages={manage} sectionsLabel={copy.sectionsLabel}
    sectionHome={copy.sectionHome} sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm}
    sectionTheme={copy.sectionTheme} sectionLifecycle={copy.sectionLifecycle} unsavedWork={copy.unsavedWork}>
    {ready ? <ZoneHomeEditor zoneId={ready.model.zoneId} zoneIri={ready.model.zoneIri}
      actingSubject={visit.actingSubject} locale={locale} copy={copy} initial={ready.model.state}
      editable={ready.model.editable} document={ready.model.document} previewHref={ready.previewPath}
      siteHref={ready.sitePath} signInHref={signInPath(localizedPath(zoneEditorPath(visit.space), locale))} />
      : failure}
  </ZoneEditorFrame>;
  const opened = settled?.draftZoneId
    ? <ZoneEditorDraftProvider zoneId={settled.draftZoneId} actingSubject={visit.actingSubject}>{frame}</ZoneEditorDraftProvider>
    : frame;
  return <ShellProvider locale={locale} messages={shellMessages} initialTheme="light" initialCollapsed={false}>
    <section aria-label={persona} className="grid min-w-0 gap-2">
      <p className="px-4 pt-3 text-sm text-muted-foreground sm:px-6 lg:px-10">{persona}</p>
      <p className="break-all px-4 text-sm text-muted-foreground sm:px-6 lg:px-10">{visit.actingSubject}</p>
      {view.kind === 'loading' ? <RouteLoading /> : opened}
    </section>
  </ShellProvider>;
}
