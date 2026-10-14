'use client';

import { cloneElement, isValidElement, useEffect, useState, type ReactNode } from 'react';
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
import { messages as realmMessages, type RealmMessages } from '../realm/messages.ts';
import realmDe from '../realm/messages/de.ts';
import realmEs from '../realm/messages/es.ts';
import realmFr from '../realm/messages/fr.ts';
import realmJa from '../realm/messages/ja.ts';
import realmKo from '../realm/messages/ko.ts';
import realmZhHans from '../realm/messages/zh-Hans.ts';
import realmZhHant from '../realm/messages/zh-Hant.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { parseTheme } from '../shell/preferences.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { ZoneEditSiteLink } from '../zone-editor/edit-site-link.tsx';
import { ZoneHomeContent } from '../zone-editor/home-content.tsx';
import { messages as zoneMessages, type ZoneMessages } from './messages.ts';
import zoneDe from './messages/de.ts';
import zoneEs from './messages/es.ts';
import zoneFr from './messages/fr.ts';
import zoneJa from './messages/ja.ts';
import zoneKo from './messages/ko.ts';
import zoneZhHans from './messages/zh-Hans.ts';
import zoneZhHant from './messages/zh-Hant.ts';
import {
  independentZoneHomeBoundary,
  independentZoneVisit,
  readIndependentZoneHome,
  type IndependentZoneRead,
} from './independent-zone-recorded-page.ts';
import {
  independentZoneFrameModel,
  independentZoneHomeBody,
  independentZoneSiteFrame,
} from './independent-zone-recorded-page-view.tsx';

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

/** Storybook has no server render, so the production home component is called with its own props. */
async function renderHome(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(renderHome));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (node.type === ZoneHomeContent) return renderHome(await ZoneHomeContent(node.props as Parameters<typeof ZoneHomeContent>[0]));
  if (!('children' in node.props)) return node;
  return cloneElement(node, { children: await renderHome(node.props.children) });
}

function recordedHome({ load, locale }: { load: Extract<IndependentZoneRead, { kind: 'published' | 'empty' }>; locale: UiLocale }) {
  const zones = { ...zoneMessages, ...zoneOverlays.get(locale) };
  const homeName = { ...realmMessages, ...realmOverlays.get(locale) }.home;
  const edit = { ...manageMessages, ...manageOverlays.get(locale) }.editSite;
  const model = independentZoneFrameModel(load.presentation, load.zone, load.zoneId, load.ref, locale, homeName, parseTheme(undefined));
  const actions = load.editor?.ok ? <ZoneEditSiteLink space={load.ref}>{edit}</ZoneEditSiteLink> : null;
  return independentZoneSiteFrame(model, undefined, actions, independentZoneHomeBody({
    mapped: load.mapped, presentation: load.presentation, zone: load.zone, zoneId: load.zoneId,
    ref: load.ref, locale, messages: zones,
  }));
}

/** One recorded independent Zone. The selections name the visit; the production home decides the page. */
export function IndependentZoneRecordedPage({ record, persona, selections, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
}) {
  const [view, setView] = useState<ReactNode>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    let replay: ReturnType<typeof recordedFetch> | undefined;
    setView(null);
    setProblem(null);
    try {
      const visit = independentZoneVisit(record, persona, selections);
      replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
      const anonymous = browserMainApi(window.location.origin, { anonymous: true, fetcher: replay.fetcher });
      const acting = browserMainApi(window.location.origin, { anonymous: visit.actingSubject === undefined, fetcher: replay.fetcher });
      void readIndependentZoneHome(independentZoneHomeBoundary({
        main: anonymous,
        personal: acting,
        actingSubject: visit.actingSubject,
        editorClient: visit.actingSubject ? acting : null,
      }), { space: visit.space, locale, actingSubject: visit.actingSubject })
        .then(async result => {
          if (!mounted) return;
          if (result.kind !== 'published' && result.kind !== 'empty') {
            setProblem(result.kind === 'discrepancy' ? result.detail : result.failure);
            return;
          }
          setView(await renderHome(recordedHome({ load: result, locale })));
        })
        .catch((error: unknown) => {
          if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
          setProblem(error instanceof Error ? error.message : String(error));
        });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
    return () => { mounted = false; replay?.dispose(); };
  }, [record, persona, selections, locale]);
  if (problem) return <p role="alert">{problem}</p>;
  if (!view) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  return view;
}
