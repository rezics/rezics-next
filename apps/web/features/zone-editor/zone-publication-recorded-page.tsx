'use client';

import type { ZoneContext, ZonePackage } from '@rezics/zone-sdk';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { surfaceText } from '../address/messages.ts';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { zoneContentText } from '../language/untagged.ts';
import { zoneText } from '../realm/adapt.ts';
import { RealmMembership } from '../realm/membership.tsx';
import { realmMessagesFor } from '../realm/story-page.tsx';
import { realmHref, siteHref } from '../realm/route.ts';
import { parseTheme } from '../shell/preferences.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { RouteLoading } from '../shell/route-states.tsx';
import { ShellProvider } from '../shell/shell-provider.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { zoneLookEnabled } from '../zones/execution.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { LookMenu } from '../zones/look-menu.tsx';
import { ZonePageMissing } from '../zones/page-missing.tsx';
import { savedSiteCuts } from '../zones/site-cuts.ts';
import { MemberList } from '../zones/site-pages.tsx';
import { ZoneSiteRecordedCredit } from '../zones/zone-site-recorded-page.tsx';
import { zoneTheme } from '../zones/theme.ts';
import { ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import { ZoneHomeContent } from './home-content.tsx';
import { readZoneManagementFrame, type ZoneManagementFrame } from './authoring-reads.ts';
import { ZoneEditorDraftProvider } from './draft-provider.tsx';
import { ZoneHomeEditor } from './editor.tsx';
import { ZoneEditorFrame } from './frame.tsx';
import { messages as zoneMessages } from './messages.ts';
import { zoneEditorPath } from './routes.ts';
import { zoneManagementMessages } from './authoring-messages.ts';
import { browserZoneAuthoring } from './api.ts';
import { PublicationReviewPanel } from './publication-review-panel.tsx';
import type { SavedPublicationSelection } from './publication-review.ts';
import { ZoneAuthoringFailure } from './states.tsx';
import {
  managementVisit, publicationTarget, readZonePublicationFrame, readZonePublicationRoute, recordedPublicationChoice,
  type ZonePublicationFrameView,
} from './zone-publication-recorded-page.ts';

type PublicView = { kind: 'loading' } | { kind: 'discrepancy'; detail: string }
  | { kind: 'ready'; view: ZonePublicationFrameView; content: ReactNode | null };

function publicationZone(view: ZonePublicationFrameView, locale: UiLocale): ZoneContext | null {
  const presentation = view.presentation;
  const ref = view.ref;
  if (!presentation || !ref) return null;
  const name = view.realmName ?? zoneContentText(presentation.name ?? presentation.address.suffixSource, presentation.language ?? '');
  return {
    slug: presentation.official,
    realm: view.realmId,
    name,
    description: null,
    icon: null,
    hero: null,
    tokens: presentation.presentation.tokens,
    locale,
    links: {
      home: siteHref(locale, ref, []),
      browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']),
      discussions: view.realmRef ? realmHref(locale, view.realmRef, 'discussions') : '',
      decisions: view.realmRef ? realmHref(locale, view.realmRef, 'decisions') : '',
      about: view.realmRef ? realmHref(locale, view.realmRef, 'about') : '',
    },
  };
}

function PublicationFrame({ view, locale, children }: { view: ZonePublicationFrameView; locale: UiLocale; children: ReactNode }) {
  const zone = publicationZone(view, locale);
  const messages = zoneMessagesFor(locale);
  const realmMessages = realmMessagesFor(locale);
  if (!zone || !view.presentation || !view.ref) return <p role="alert">publication frame has no site address</p>;
  const cuts = savedSiteCuts(
    { tokens: zone.tokens, navigation: view.presentation.presentation.navigation },
    view.presentation.navigation.map(mount => ({ segment: mount.segment, name: zoneText(mount.name) })),
    view.ref, locale, realmMessages.home);
  const here = siteHref(locale, view.ref, []);
  const actions = view.realmId ? <>
    <RealmMembership realm={view.realmId} realmName={zone.name.value} initial={null} signedIn={false}
      signInHref={signInPath(here)} rulesHref={zone.links.about} locale={locale} messages={realmMessages} />
    <LocalizedLink href={realmHref(locale, view.realmRef ?? view.ref)}
      className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
      {surfaceText.community[locale]}
    </LocalizedLink>
    <LookMenu enabled={zoneLookEnabled(undefined)} labels={{ menu: messages.lookLabel, zone: messages.lookZone,
      standard: messages.lookStandard, help: messages.lookHelp, saveFailed: messages.lookSaveFailed }} />
  </> : null;
  const label = view.kind === 'attached' ? surfaceText.site[locale] : zone.name.value;
  const theme = zoneTheme(cuts.tokens, { reader: parseTheme(undefined), enabled: zoneLookEnabled(undefined) });
  return <ZoneFrame zone={zone} dataZone={zone.slug ?? view.realmId ?? view.ref} theme={theme}
    pkg={null as ZonePackage | null} actions={actions} members={null}
    masthead={<ZoneMasthead zone={zone} members={null} actions={actions} />} tabs={null}
    site={{ label, links: cuts.navigation }}>
    <ReaderActionsProvider signedIn={false} signInHref={signInPath(here)}>{children}</ReaderActionsProvider>
  </ZoneFrame>;
}

/** One persona's recorded publication page. The production frame reader decides the cut. */
export function ZonePublicationRecordedPage({ record, persona, selections, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
}) {
  const target = publicationTarget(record, persona, selections);
  const acting = target.actingSubject;
  const mode = target.mode;
  const space = target.space;
  const routePath = target.mode === 'route' ? target.path : '';
  const homeRoute = target.mode === 'frame' ? target.homeRoute : false;
  const [view, setView] = useState<PublicView>({ kind: 'loading' });
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    async function load() {
      const loaded = mode === 'frame'
        ? await readZonePublicationFrame(replay.fetcher, space, locale, acting, homeRoute)
        : await readZonePublicationRoute(replay.fetcher, space, locale, routePath, acting);
      const mapped = loaded.mapped;
      const zone = publicationZone(loaded, locale);
      let content: ReactNode | null = null;
      if (zone && loaded.presentation && (mapped.kind === 'published' || mapped.kind === 'empty')) {
        const home = await ZoneHomeContent({
          page: mapped.kind === 'published' ? mapped.page : null,
          presentation: loaded.presentation.presentation, moduleData: loaded.presentation.moduleData,
          slideMedia: loaded.presentation.slideMedia,
          context: {
            locale, ref: loaded.ref ?? space, realm: loaded.realmId ?? space,
            ...(loaded.kind === 'attached' ? {
              zone: space, mounts: new Map(loaded.presentation.navigation.map(mount => [mount.target, mount.segment])),
            } : { unrouted: true }),
          },
          zone, pkg: null, messages: zoneMessagesFor(locale),
          empty: mapped.kind === 'empty' ? <PageContainer><MemberList members={[]} /></PageContainer> : undefined,
        });
        content = mapped.kind === 'published' && mapped.credit
          ? <>{home}<ZoneSiteRecordedCredit credit={mapped.credit} /></> : home;
      }
      if (!mounted) return;
      setView({ kind: 'ready', view: loaded, content });
    }
    void load().catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setView({ kind: 'discrepancy', detail: error instanceof Error ? error.message : String(error) });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, selections, locale, mode, space, acting, routePath, homeRoute]);
  const messages = zoneMessagesFor(locale);
  const ready = view.kind === 'ready' ? view.view : null;
  const zone = ready ? publicationZone(ready, locale) : null;
  const mapped = ready?.mapped;
  const body = view.kind === 'discrepancy' ? <p role="alert">{view.detail}</p>
    : !ready || !mapped ? <p role="status" aria-busy="true">{shellMessages.loading}</p>
    : mapped.kind === 'discrepancy' || mapped.kind === 'unavailable' ? <p role="alert">{mapped.kind === 'discrepancy' ? mapped.detail : mapped.failure}</p>
    : mapped.kind === 'refusal' ? <ZonePageMissing title={messages.pageMissingTitle} body={messages.pageMissingBody}
      back={messages.pageMissingBack} href={localizedPath(ready.backHref ?? '/', locale)} />
    : ready.presentation && zone && view.kind === 'ready' && view.content
      ? <PublicationFrame view={ready} locale={locale}>{view.content}</PublicationFrame>
      : <p role="alert">publication frame has no presentation</p>;
  return <section aria-label={persona} className="grid min-w-0 gap-2">
    <p className="px-4 pt-3 text-sm text-muted-foreground sm:px-6 lg:px-10">{persona}</p>
    {acting ? <p className="break-all px-4 text-sm text-muted-foreground sm:px-6 lg:px-10">{acting}</p> : null}
    {body}
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
  const catalogs = zoneManagementMessages(locale);
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
    agent={agent} locale={locale} manageMessages={catalogs.manage} sectionsLabel={copy.sectionsLabel}
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
  return <ShellProvider locale={locale} messages={catalogs.shell} initialTheme="light" initialCollapsed={false}>
    <section aria-label={persona} className="grid min-w-0 gap-2">
      <p className="px-4 pt-3 text-sm text-muted-foreground sm:px-6 lg:px-10">{persona}</p>
      <p className="break-all px-4 text-sm text-muted-foreground sm:px-6 lg:px-10">{visit.actingSubject}</p>
      {view.kind === 'loading' ? <RouteLoading /> : opened}
    </section>
  </ShellProvider>;
}

type CommandResult = { kind: 'idle' } | { kind: 'published'; replayed: boolean; homeDocument: string; revisionId: string; byteDigest: string }
  | { kind: 'refused'; title: string; code: string } | { kind: 'discrepancy'; detail: string };

function commandSelection(record: AnswerRecord, persona: AnswerPersona, presentationLabel: string,
  command: ReturnType<typeof recordedPublicationChoice>): SavedPublicationSelection {
  const answer = record.personas[persona].find(sample => sample.label === presentationLabel)?.answer as {
    presentation?: { tokens?: { density?: string; pageSurface?: string }; navigation?: SavedPublicationSelection['presentationNavigation'] };
  } | undefined;
  const tokens = answer?.presentation?.tokens;
  const density = tokens?.density === 'compact' ? 'compact' : 'comfortable';
  const pageSurface = tokens?.pageSurface === 'cards' ? 'cards' : 'flat';
  return {
    homeDocument: command.choice.page,
    zoneHead: command.choice.zoneHead,
    navigationRevision: command.choice.navigationRevision,
    navigationId: command.choice.navigationRevision,
    navigation: [],
    presentationNavigation: answer?.presentation?.navigation ?? [],
    theme: { density, pageSurface },
  };
}

/** The publication command the review panel sends, replayed through the production authoring client. */
export function ZonePublicationCommandPage({ record, persona, selections, locale, commandLabel, presentationLabel, sequence = false }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
  commandLabel: string;
  presentationLabel: string;
  sequence?: boolean;
}) {
  const command = recordedPublicationChoice(record, persona, commandLabel);
  const selection = commandSelection(record, persona, presentationLabel, command);
  const copy = zoneMessages[locale];
  const [result, setResult] = useState<CommandResult>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const transport = useRef<ReturnType<typeof recordedFetch> | null>(null);
  useEffect(() => () => transport.current?.dispose(), []);
  const publish = () => {
    setBusy(true);
    const replay = transport.current ?? recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, sequence });
    transport.current = replay;
    const authoring = browserZoneAuthoring(browserMainApi('https://recorded.invalid', { fetcher: replay.fetcher }));
    void authoring.publish(command.choice, command.actingSubject, 'recorded-publication', command.zoneId).then(written => {
      if (!written.ok) {
        setResult(written.problem ? { kind: 'refused', title: written.problem.title, code: written.problem.code }
          : { kind: 'discrepancy', detail: written.failure });
        return;
      }
      const page = written.data.receipt?.pages[0];
      if (!written.data.receipt || !page) {
        setResult({ kind: 'discrepancy', detail: 'publication receipt has no page' });
        return;
      }
      setResult({ kind: 'published', replayed: written.data.replayed, homeDocument: written.data.receipt.homeDocument,
        revisionId: page.revisionId, byteDigest: page.byteDigest });
    }).catch((error: unknown) => {
      setResult({ kind: 'discrepancy', detail: error instanceof Error ? error.message : String(error) });
    }).finally(() => { setBusy(false); });
  };
  return <section aria-label={persona} className="grid min-w-0 gap-3 px-4 py-3 sm:px-6 lg:px-10">
    <p className="text-sm text-muted-foreground">{persona}</p>
    <p className="break-all text-sm text-muted-foreground">{command.actingSubject}</p>
    <PublicationReviewPanel selection={selection} copy={copy} busy={busy} onPublish={publish} />
    {result.kind === 'published' ? <div className="grid gap-1 text-sm">
      <p>{result.replayed ? result.revisionId : copy.published}</p>
      <p className="break-all">{result.homeDocument}</p>
      <p className="break-all">{result.revisionId}</p>
      <p className="break-all">{result.byteDigest}</p>
    </div> : result.kind === 'refused' ? <p role="alert">{result.title}</p>
      : result.kind === 'discrepancy' ? <p role="alert">{result.detail}</p> : null}
    {result.kind === 'refused' ? <p className="text-sm text-muted-foreground">{result.code}</p> : null}
  </section>;
}
