'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { messages as manageMessages, type ManageMessages } from '../manage/messages.ts';
import manageDe from '../manage/messages/de.ts';
import manageEs from '../manage/messages/es.ts';
import manageFr from '../manage/messages/fr.ts';
import manageJa from '../manage/messages/ja.ts';
import manageKo from '../manage/messages/ko.ts';
import manageZhHans from '../manage/messages/zh-Hans.ts';
import manageZhHant from '../manage/messages/zh-Hant.ts';
import { zoneText } from '../realm/adapt.ts';
import { publishedFrameModel } from '../realm/zone-presentation-read.ts';
import { messages as realmMessages, type RealmMessages } from '../realm/messages.ts';
import realmDe from '../realm/messages/de.ts';
import realmEs from '../realm/messages/es.ts';
import realmFr from '../realm/messages/fr.ts';
import realmJa from '../realm/messages/ja.ts';
import realmKo from '../realm/messages/ko.ts';
import realmZhHans from '../realm/messages/zh-Hans.ts';
import realmZhHant from '../realm/messages/zh-Hant.ts';
import { siteHref } from '../realm/route.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { zoneEditorPath } from '../zone-editor/routes.ts';
import { messages as zoneMessages, type ZoneMessages } from './messages.ts';
import zoneDe from './messages/de.ts';
import zoneEs from './messages/es.ts';
import zoneFr from './messages/fr.ts';
import zoneJa from './messages/ja.ts';
import zoneKo from './messages/ko.ts';
import zoneZhHans from './messages/zh-Hans.ts';
import zoneZhHant from './messages/zh-Hant.ts';
import { MemberList, ZoneDocumentHome } from './site-pages.tsx';
import { ZoneFrame, ZoneMasthead } from './zone-frame.tsx';
import { ZoneSiteRecordedCredit } from './zone-site-recorded-page.tsx';
import {
  independentZoneVisit,
  readIndependentZonePublished,
  type IndependentZoneRead,
} from './independent-zone-recorded-page.ts';

const zoneOverlays = new Map<UiLocale, Partial<ZoneMessages>>([
  ['zh-Hant', zoneZhHant], ['zh-Hans', zoneZhHans], ['ja', zoneJa], ['ko', zoneKo],
  ['de', zoneDe], ['fr', zoneFr], ['es', zoneEs],
]);
const realmOverlays = new Map<UiLocale, Partial<RealmMessages>>([
  ['zh-Hant', realmZhHant], ['zh-Hans', realmZhHans], ['ja', realmJa], ['ko', realmKo],
  ['de', realmDe], ['fr', realmFr], ['es', realmEs],
]);
const manageOverlays = new Map<UiLocale, Partial<ManageMessages>>([
  ['zh-Hant', manageZhHant], ['zh-Hans', manageZhHans], ['ja', manageJa], ['ko', manageKo],
  ['de', manageDe], ['fr', manageFr], ['es', manageEs],
]);

/** The same edit-site control the frame shows after a selected Agent can open the editor. */
function EditSiteLink({ space, locale }: { space: string; locale: UiLocale }) {
  const label = { ...manageMessages, ...manageOverlays.get(locale) }.editSite;
  return <LocalizedLink href={zoneEditorPath(space)} documentNavigation
    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>{label}</LocalizedLink>;
}

function Frame({ load, locale, children }: {
  load: Extract<IndependentZoneRead, { kind: 'published' | 'empty' }>;
  locale: UiLocale;
  children: ReactNode;
}) {
  const homeName = { ...realmMessages, ...realmOverlays.get(locale) }.home;
  const model = publishedFrameModel(load.presentation, load.zoneId, locale, homeName, '', {
    reader: 'system',
    ref: load.ref,
    zone: load.zone,
  });
  const { zone: frameZone, cuts, theme } = model;
  const actions = load.editor?.ok ? <EditSiteLink space={load.ref} locale={locale} /> : null;
  return <ZoneFrame zone={frameZone} dataZone={load.zoneId} theme={theme} pkg={null}
    masthead={<ZoneMasthead zone={frameZone} members={null} actions={actions} />} actions={actions} members={null}
    tabs={null} site={{ label: frameZone.name.value, links: cuts.navigation }}>
    {children}
  </ZoneFrame>;
}

function RecordedBody({ load, locale }: { load: IndependentZoneRead; locale: UiLocale }) {
  if (load.kind === 'discrepancy') return <p role="alert">{load.detail}</p>;
  if (load.kind === 'unavailable') return <p role="alert">{load.failure}</p>;
  if (load.kind === 'refusal') return <p role="alert">{load.problem?.title ?? load.problem?.code ?? ''}</p>;
  const zones = { ...zoneMessages, ...zoneOverlays.get(locale) };
  if (load.kind === 'empty') {
    return <Frame load={load} locale={locale}>
      <PageContainer>
        <MemberList members={load.presentation.navigation.map(mount => ({
          id: mount.target,
          href: siteHref(locale, load.ref, [mount.segment]),
          name: zoneText(mount.name),
          kind: null,
        }))} />
      </PageContainer>
    </Frame>;
  }
  return <Frame load={load} locale={locale}>
    <ZoneDocumentHome page={load.mapped.page} modules={[]} zone={load.zone} pkg={null} locale={locale} messages={zones} />
    {load.credit ? <ZoneSiteRecordedCredit credit={load.credit} /> : null}
  </Frame>;
}

/** One recorded independent Zone: the selections name the visit, and the production mapping decides the page. */
export function IndependentZoneRecordedPage({ record, persona, selections, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
}) {
  const [load, setLoad] = useState<IndependentZoneRead | null>(null);
  useEffect(() => {
    let mounted = true;
    let replay: ReturnType<typeof recordedFetch> | undefined;
    try {
      const visit = independentZoneVisit(record, persona, selections);
      replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
      const main = browserMainApi(window.location.origin, {
        anonymous: visit.actingSubject === undefined,
        fetcher: replay.fetcher,
      });
      void readIndependentZonePublished(main, {
        space: visit.space, locale, actingSubject: visit.actingSubject,
        origin: window.location.origin, fetcher: replay.fetcher,
      })
        .then(result => { if (mounted) setLoad(result); })
        .catch((error: unknown) => {
          if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
          setLoad({ kind: 'discrepancy', detail: error instanceof Error ? error.message : String(error) });
        });
    } catch (error) {
      setLoad({ kind: 'discrepancy', detail: error instanceof Error ? error.message : String(error) });
    }
    return () => { mounted = false; replay?.dispose(); };
  }, [record, persona, selections, locale]);
  if (!load) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  return <RecordedBody load={load} locale={locale} />;
}
