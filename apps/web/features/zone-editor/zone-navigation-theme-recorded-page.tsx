'use client';

import { ResolvedMediaImages } from '@rezics/ui/media-image';
import type { ZoneMember } from '@rezics/zone-sdk';
import { useEffect, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { CanonicalAddress } from '@rezics/model/address';
import { addressKey, spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { ReadFailure } from '../manage/types.ts';
import { messages as realmMessages } from '../realm/messages.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection, type RecordedState } from '../stories/recorded-fetch.ts';
import { defaultPresentation } from '../zones/presentation.ts';
import { zoneMessagesFor } from '../zones/fixtures.ts';
import { messages as zoneMessagesCatalog } from '../zones/messages.ts';
import { ZonePageMissing } from '../zones/page-missing.tsx';
import { MemberList, ZoneDocumentHome } from '../zones/site-pages.tsx';
import { ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import { loadZoneNavigation } from './api.ts';
import { ZoneEditorDraftProvider } from './draft-provider.tsx';
import { ZoneEditorFrame } from './frame.tsx';
import { zoneHomeDocument } from './home-document.tsx';
import { messages as editorMessages } from './messages.ts';
import { ZoneNavigationEditor } from './navigation-editor.tsx';
import { messages as manageMessages } from '../manage/messages.ts';
import { ZoneAuthoringFailure } from './states.tsx';
import { ZoneThemeEditor } from './theme-editor.tsx';
import type { ThemeEditorStart } from './theme.ts';
import { zoneNavigationPath, zonePreviewPath, zoneThemePath } from './routes.ts';
import {
  loadCompletePresentation,
  loadNavigationEditor,
  loadPublishedFrame,
  loadRecordedRoute,
  loadThemeEditor,
  recordedActingSubject,
  recordedIndexMembers,
  recordedRoutePath,
  recordedThemeSaveKey,
  recordedThemeWrite,
  saveRecordedTheme,
  themeEditorAfterStaleSave,
  zoneIdFromRecordedPath,
  type RecordedPublishedFrame,
} from './zone-navigation-theme-recorded-page.ts';

export interface RecordedNavigationThemeProps {
  record: AnswerRecord;
  persona: AnswerPersona;
  locale?: UiLocale;
  /** Published, republished or empty-home presentation sample. */
  presentation?: string;
  presentationState?: 'populated' | 'empty' | 'loading';
  /** Index or refused route sample. */
  route?: string;
  routeState?: 'empty' | 'error';
  /** Authorized or refused configuration sample. */
  configuration?: string;
  configurationState?: 'populated' | 'error';
  /** Stale configuration write. The body is the recorded request body. */
  save?: string;
  /** Authorized navigation inventory. Loading holds that Zone read unanswered. */
  navigation?: string;
  navigationState?: 'populated' | 'loading';
  /** Showcase read that carries the home draft beside the navigation. */
  navigationDraft?: string;
  /** Zone read without a page size. The authoring adapter uses it for the two heads. */
  navigationHeads?: string;
  /** Collection name read for each mount target. */
  mountNames?: string;
  /** Work read for a mount target. A recorded refusal stays a refusal. */
  mountWork?: string;
}

type Screen =
  | { kind: 'frame'; frame: RecordedPublishedFrame; index: ZoneMember[] | null }
  | { kind: 'missing'; href: string }
  | { kind: 'theme'; zoneId: string; acting: string; name: string; start: ThemeEditorStart }
  | { kind: 'navigation'; zoneId: string; zoneIri: string; acting: string; name: string;
      navigation: Awaited<ReturnType<typeof loadNavigationEditor>> & { kind: 'editor' } }
  | { kind: 'denied'; failure: ReadFailure };

/** Stories and the mapping unit render a recorded navigation or theme answer through the production readers. */
export function RecordedNavigationTheme({ record, persona, locale = 'en', presentation, presentationState = 'populated',
  route, routeState = 'empty', configuration, configurationState = 'populated', save, navigation,
  navigationState = 'populated', navigationDraft, navigationHeads, mountNames, mountWork }: RecordedNavigationThemeProps) {
  const [screen, setScreen] = useState<Screen | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const selections = recordedSelections({ presentation, presentationState, route, routeState, configuration,
      configurationState, save, navigation, navigationState, navigationDraft, navigationHeads, mountNames, mountWork });
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
    const zoneMessages = zoneMessagesFor(locale);
    async function load(): Promise<Screen> {
      if (save) {
        const sample = recordedSample(record, persona, save);
        const zoneId = zoneIdFromRecordedPath(sample.path);
        const write = recordedThemeWrite(sample.body);
        const saved = await saveRecordedTheme(main, zoneId, write, recordedThemeSaveKey);
        if (saved.ok || saved.failure !== 'stale') {
          throw new Error(`Recorded theme save was ${saved.ok ? 'accepted' : saved.failure}`);
        }
        const state = themeEditorAfterStaleSave(write);
        if (!state) throw new Error('Recorded stale presentation did not open in the theme editor');
        const named = presentation ? await loadCompletePresentation(main, zoneIdFromRecordedPath(
          recordedSample(record, persona, presentation).path)) : null;
        if (named && !named.ok) throw new Error(`Recorded presentation read failed: ${named.failure}`);
        const name = named?.ok ? named.data.name ?? named.data.address.suffixSource : write.actingSubject;
        return { kind: 'theme', zoneId, acting: write.actingSubject, name, start: { kind: 'ready', state } };
      }
      if (navigation) {
        const sample = recordedSample(record, persona, navigation);
        const zoneId = zoneIdFromRecordedPath(sample.path);
        const acting = recordedActingSubject(sample.path);
        if (navigationState === 'loading') {
          const held = await loadZoneNavigation(main, zoneId, acting);
          throw new Error(held.ok
            ? 'Recorded navigation read resolved while it was held'
            : `Recorded navigation read failed: ${held.failure}`);
        }
        const loaded = await loadNavigationEditor(main, zoneId, acting);
        if (loaded.kind !== 'editor') throw new Error(`Recorded navigation read failed: ${loaded.failure}`);
        const name = recordedName(sample.answer);
        const zoneIri = recordedZoneIri(sample.answer);
        if (!name) throw new Error('Recorded navigation has no zone name');
        return { kind: 'navigation', zoneId, zoneIri, acting, name, navigation: loaded };
      }
      if (configuration) {
        const sample = recordedSample(record, persona, configuration);
        const zoneId = zoneIdFromRecordedPath(sample.path);
        const acting = recordedActingSubject(sample.path);
        const loaded = await loadThemeEditor(main, zoneId, acting, defaultPresentation(zoneMessages));
        if (loaded.kind === 'failure') return { kind: 'denied', failure: editorFailure(loaded.failure) };
        const name = recordedName(sample.answer);
        if (!name) throw new Error('Recorded configuration has no zone name');
        return { kind: 'theme', zoneId, acting, name, start: loaded.start };
      }
      if (!presentation) throw new Error('Recorded page has no presentation sample');
      const sample = recordedSample(record, persona, presentation);
      const zoneId = zoneIdFromRecordedPath(sample.path);
      if (route && routeState === 'error') {
        const routeSample = recordedSample(record, persona, route);
        const [frame, read] = await Promise.all([
          loadPublishedFrame(main, zoneId, locale, realmMessages.home, zoneMessages.moduleHeroCarousel),
          loadRecordedRoute(main, zoneIdFromRecordedPath(routeSample.path), recordedRoutePath(routeSample.path)),
        ]);
        if (!frame.ok) throw new Error(`Recorded presentation read failed: ${frame.failure}`);
        if (read.ok || read.failure !== 'missing') {
          throw new Error(`Recorded route read was ${read.ok ? 'accepted' : read.failure}`);
        }
        return { kind: 'missing', href: spaceHref(frame.data.ref, 'site') };
      }
      const frame = await loadPublishedFrame(main, zoneId, locale, realmMessages.home, zoneMessages.moduleHeroCarousel);
      if (!frame.ok) throw new Error(`Recorded presentation read failed: ${frame.failure}`);
      if (!route) return { kind: 'frame', frame: frame.data, index: null };
      const routeSample = recordedSample(record, persona, route);
      const read = await loadRecordedRoute(main, zoneIdFromRecordedPath(routeSample.path),
        recordedRoutePath(routeSample.path));
      if (!read.ok) throw new Error(`Recorded route read failed: ${read.failure}`);
      if (read.data.kind !== 'index') throw new Error(`Recorded route was ${read.data.kind}`);
      return { kind: 'frame', frame: frame.data, index: recordedIndexMembers(read.data, frame.data.ref) };
    }
    void load().then(next => { if (active) setScreen(next); }).catch((reason: unknown) => {
      if (!active) return;
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => { active = false; replay.dispose(); };
  }, [record, persona, locale, presentation, presentationState, route, routeState, configuration,
    configurationState, save, navigation, navigationState, navigationDraft, navigationHeads, mountNames, mountWork]);
  if (error) throw error;
  if (!screen) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  if (screen.kind === 'missing') {
    const copy = zoneMessagesCatalog;
    return <ZonePageMissing title={copy.pageMissingTitle} body={copy.pageMissingBody} back={copy.pageMissingBack}
      href={screen.href} />;
  }
  if (screen.kind === 'denied') return <ZoneAuthoringFailure failure={screen.failure} copy={editorMessages[locale]} />;
  if (screen.kind === 'navigation') {
    const copy = editorMessages[locale];
    const address = ownerSiteAddress(record);
    const edited = screen.navigation;
    return <ZoneEditorDraftProvider zoneId={screen.zoneId} actingSubject={screen.acting}>
      <ZoneEditorFrame name={screen.name} editorPath={zoneNavigationPath(screen.zoneId)}
        agent={{ iri: screen.acting, label: screen.acting, handle: null, kind: 'person', path: 'direct-principal' }}
        locale={locale} manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel} sectionHome={copy.sectionHome}
        sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm} sectionTheme={copy.sectionTheme}>
        <ZoneNavigationEditor zoneId={screen.zoneId} zoneIri={screen.zoneIri} actingSubject={screen.acting}
          locale={locale} copy={copy} initial={edited.navigation} home={edited.home}
          previewHref={zonePreviewPath(addressKey(address))} siteHref={spaceHref(address, 'site')}
          signInHref="/auth/start" api={edited.client} />
      </ZoneEditorFrame>
    </ZoneEditorDraftProvider>;
  }
  if (screen.kind === 'theme') {
    const copy = editorMessages[locale];
    return <ZoneEditorDraftProvider zoneId={screen.zoneId} actingSubject={screen.acting}>
      <ZoneEditorFrame name={screen.name} editorPath={zoneThemePath(screen.zoneId)}
        agent={{ iri: screen.acting, label: screen.acting, handle: null, kind: 'person', path: 'direct-principal' }}
        locale={locale} manageMessages={manageMessages} sectionsLabel={copy.sectionsLabel} sectionHome={copy.sectionHome}
        sectionNavigation={copy.sectionNavigation} sectionRealm={copy.sectionRealm} sectionTheme={copy.sectionTheme}>
        <ZoneThemeEditor zoneId={screen.zoneId} actingSubject={screen.acting} copy={copy} initial={screen.start}
          signInHref="/auth/start" shellPresentation={defaultPresentation(zoneMessagesFor(locale))} />
      </ZoneEditorFrame>
    </ZoneEditorDraftProvider>;
  }
  return <PublishedFrame frame={screen.frame} index={screen.index} locale={locale} />;
}

function PublishedFrame({ frame, index, locale }: { frame: RecordedPublishedFrame; index: ZoneMember[] | null;
  locale: UiLocale }) {
  const messages = zoneMessagesFor(locale);
  const home = frame.home && zoneHomeDocument(frame.home) ? frame.home : null;
  const body = index ? <PageContainer><MemberList members={index} /></PageContainer>
    : home ? <ResolvedMediaImages images={{}}>
      <ZoneDocumentHome page={home} modules={frame.hero ? [frame.hero] : []} zone={frame.zone} pkg={null}
        locale={locale} messages={messages} />
    </ResolvedMediaImages>
    : <PageContainer><MemberList members={frame.mounts} /></PageContainer>;
  return <ZoneFrame zone={frame.zone} dataZone={frame.zoneId} theme={frame.theme} pkg={null} members={null}
    actions={null} masthead={<ZoneMasthead zone={frame.zone} members={null} actions={null} />} tabs={null}
    site={{ label: frame.zone.name.value, links: frame.cuts.navigation }}>
    {body}
  </ZoneFrame>;
}

function recordedSelections({ presentation, presentationState, route, routeState, configuration, configurationState,
  save, navigation, navigationState, navigationDraft, navigationHeads, mountNames, mountWork }: Pick<
  RecordedNavigationThemeProps, 'presentation' | 'presentationState' | 'route' | 'routeState'
  | 'configuration' | 'configurationState' | 'save' | 'navigation' | 'navigationState' | 'navigationDraft'
  | 'navigationHeads' | 'mountNames' | 'mountWork'>): RecordedSelection[] {
  const selections: RecordedSelection[] = [];
  if (presentation) selections.push({ label: presentation, state: presentationState ?? 'populated' });
  if (route) selections.push({ label: route, state: routeState ?? 'empty' });
  if (configuration) selections.push({ label: configuration, state: configurationState ?? 'populated' });
  if (save) selections.push({ label: save, state: 'error' satisfies RecordedState });
  if (navigation) selections.push({ label: navigation, state: navigationState ?? 'populated' });
  if (navigationDraft) selections.push({ label: navigationDraft, state: 'populated' });
  if (navigationHeads) selections.push({ label: navigationHeads, state: 'populated' });
  if (mountNames) selections.push({ label: mountNames, state: 'populated' });
  if (mountWork) selections.push({ label: mountWork, state: 'error' satisfies RecordedState });
  return selections;
}

function recordedSample(record: AnswerRecord, persona: AnswerPersona, label: string) {
  const found = record.personas[persona].find(item => item.label === label);
  if (!found) throw new Error(`Missing recorded sample ${record.row}/${persona}/${label}`);
  return found;
}

function recordedName(answer: unknown): string | null {
  return answer && typeof answer === 'object' && 'name' in answer && typeof answer.name === 'string' ? answer.name : null;
}

function recordedZoneIri(answer: unknown): string {
  if (answer && typeof answer === 'object' && 'zone' in answer && typeof answer.zone === 'string') return answer.zone;
  throw new Error('Recorded navigation has no zone');
}

function ownerSiteAddress(record: AnswerRecord): CanonicalAddress {
  const answer = recordedSample(record, 'owner', 'republished-presentation').answer;
  if (!answer || typeof answer !== 'object' || !('address' in answer) || !answer.address
    || typeof answer.address !== 'object') {
    throw new Error('Recorded site has no address');
  }
  return answer.address as CanonicalAddress;
}

function editorFailure(failure: string): ReadFailure {
  if (failure === 'denied' || failure === 'sign-in' || failure === 'missing' || failure === 'invalid'
    || failure === 'unavailable' || failure === 'moved' || failure === 'budget') return failure;
  return 'unavailable';
}
