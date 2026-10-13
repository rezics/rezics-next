'use client';

import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneContext } from '@rezics/zone-sdk';
import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { addressKey } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { zoneImage, zoneText } from '../realm/adapt.ts';
import { buildBrowsePage } from '../realm/browse-page.ts';
import { readBrowseAnswer, readFacetAnswer } from '../realm/browse-page-read.ts';
import { messages as realmMessages, type RealmMessages } from '../realm/messages.ts';
import realmDe from '../realm/messages/de.ts';
import realmEs from '../realm/messages/es.ts';
import realmFr from '../realm/messages/fr.ts';
import realmJa from '../realm/messages/ja.ts';
import realmKo from '../realm/messages/ko.ts';
import realmZhHans from '../realm/messages/zh-Hans.ts';
import realmZhHant from '../realm/messages/zh-Hant.ts';
import { realmHref, siteHref } from '../realm/route.ts';
import { RealmPageStory } from '../realm/story-page.tsx';
import { RealmUnavailable } from '../realm/states.tsx';
import type { FacetList, Loaded, RealmHeader, ZonePresentationRead } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection, type RecordedState } from '../stories/recorded-fetch.ts';
import { ZoneBrowse } from './browse.tsx';
import type { BrowseModel } from './browse-view.ts';
import { messages as zoneMessages, type ZoneMessages } from './messages.ts';
import zoneDe from './messages/de.ts';
import zoneEs from './messages/es.ts';
import zoneFr from './messages/fr.ts';
import zoneJa from './messages/ja.ts';
import zoneKo from './messages/ko.ts';
import zoneZhHans from './messages/zh-Hans.ts';
import zoneZhHant from './messages/zh-Hant.ts';
import { cardRenderer } from './zone-home.tsx';
import { recordedActingSubject, recordedBrowseCall, recordedSample } from './manga-browse-recorded-page.ts';

const zoneOverlays = new Map<UiLocale, Partial<ZoneMessages>>([
  ['zh-Hant', zoneZhHant], ['zh-Hans', zoneZhHans], ['ja', zoneJa], ['ko', zoneKo],
  ['de', zoneDe], ['fr', zoneFr], ['es', zoneEs],
]);
const realmOverlays = new Map<UiLocale, Partial<RealmMessages>>([
  ['zh-Hant', realmZhHant], ['zh-Hans', realmZhHans], ['ja', realmJa], ['ko', realmKo],
  ['de', realmDe], ['fr', realmFr], ['es', realmEs],
]);

const frameLabels = ['facet-labels', 'realm-context', 'zone-presentation'] as const;

function zoneCopy(locale: UiLocale): ZoneMessages {
  return { ...zoneMessages, ...zoneOverlays.get(locale) };
}

function realmCopy(locale: UiLocale): RealmMessages {
  return { ...realmMessages, ...realmOverlays.get(locale) };
}

function unread(kind: string, error: unknown): string {
  return `Recorded ${kind} answer was not readable by the typed client: ${JSON.stringify(error)}`;
}

/** The recorded site's public segment. No official package was recorded for this realm. */
function siteRef(presentation: ZonePresentationRead): string {
  const address = presentation.address as CanonicalAddress;
  return presentation.official ?? addressKey(address);
}

function zoneFrom(header: RealmHeader, presentation: ZonePresentationRead, locale: UiLocale): ZoneContext {
  const ref = siteRef(presentation);
  return {
    slug: ref,
    realm: header.id,
    name: zoneText(header.name),
    description: zoneText(header.description),
    icon: zoneImage(header.icon),
    hero: zoneImage(header.banner),
    tokens: presentation.presentation.tokens,
    locale,
    links: {
      home: siteHref(locale, ref, []),
      browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']),
      discussions: realmHref(locale, ref, 'discussions'),
      decisions: realmHref(locale, ref, 'decisions'),
      about: realmHref(locale, ref, 'about'),
    },
  };
}

function Loading({ children }: { children?: ReactNode }) {
  return <PageContainer><p role="status" aria-busy="true">{children ?? shellMessages.loading}</p></PageContainer>;
}

/**
 * The catalogue browse the route renders, from one persona's recorded answers.
 * Frame samples are replayed only when that persona recorded them.
 */
export function MangaBrowseRecordedPage({ record, persona, label, state, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  label: string;
  state: RecordedState;
  locale: UiLocale;
}) {
  const [shown, setShown] = useState<{ zone: ZoneContext; page: Loaded<BrowseModel> | null } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const selections: RecordedSelection[] = [{ label, state }];
    for (const extra of frameLabels) {
      if (record.personas[persona].some(sample => sample.label === extra)) {
        selections.push({ label: extra, state: 'populated' });
      }
    }
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher });
    const request = recordedBrowseCall(recordedSample(record, persona, label).path);
    const zones = zoneCopy(locale);
    async function load() {
      const headerPath = selections.some(item => item.label === 'realm-context')
        ? recordedSample(record, persona, 'realm-context').path : null;
      const presentationPath = selections.some(item => item.label === 'zone-presentation')
        ? recordedSample(record, persona, 'zone-presentation').path : null;
      if (!headerPath || !presentationPath) {
        throw new Error(`Recorded ${record.row}/${persona} has no realm header or zone presentation`);
      }
      const headerActor = recordedActingSubject(headerPath);
      const presentationActor = recordedActingSubject(presentationPath);
      const zoneId = new URL(presentationPath, 'https://recorded.invalid').pathname.split('/')[3];
      if (!zoneId) throw new Error(`Recorded zone presentation has no zone: ${presentationPath}`);
      const [header, presentation] = await Promise.all([
        main.v1.realms({ realm: request.realm }).get(headerActor ? { query: { actingSubject: headerActor } } : {}),
        main.v1.zones({ id: zoneId }).presentation.get(presentationActor ? { query: { actingSubject: presentationActor } } : {}),
      ]);
      if (header.error || !header.data) throw new Error(unread('realm header', header.error));
      if (presentation.error || !presentation.data) throw new Error(unread('zone presentation', presentation.error));
      const zone = zoneFrom(header.data, presentation.data, locale);
      if (active) setShown({ zone, page: null });
      const [page, facets] = await Promise.all([
        readBrowseAnswer(main, request.realm, request.query),
        selections.some(item => item.label === 'facet-labels')
          ? readFacetAnswer(main)
          : Promise.resolve({ ok: false, failure: 'unavailable' } satisfies Loaded<FacetList>),
      ]);
      const built = buildBrowsePage({
        page, facets, base: zone.links.browse, zoneName: zone.name.value, state: request.state,
        context: { realm: request.realm, ref: siteRef(presentation.data), locale }, locale, messages: zones,
      });
      if (active) setShown({ zone, page: built });
    }
    void load().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => { active = false; replay.dispose(); };
  }, [record, persona, label, state, locale]);
  if (error) throw error;
  const zones = zoneCopy(locale);
  const realms = realmCopy(locale);
  if (!shown) return <Loading />;
  const body = !shown.page
    ? <Loading />
    : shown.page.ok
      ? <ZoneBrowse model={shown.page.data} messages={zones} card={cardRenderer(shown.zone, null, locale, zones)} />
      : <RealmUnavailable messages={realms} failure={shown.page.failure} reference={shown.page.reference} />;
  return <RealmPageStory zone={shown.zone} locale={locale} site>{body}</RealmPageStory>;
}
