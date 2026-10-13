'use client';

import type { CanonicalAddress } from '@rezics/model/address';
import type { ZoneContext } from '@rezics/zone-sdk';
import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { addressKey, spaceHref } from '../address/path.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { zoneContentText } from '../language/untagged.ts';
import { zoneText } from '../realm/adapt.ts';
import { messages as realmMessages, type RealmMessages } from '../realm/messages.ts';
import realmDe from '../realm/messages/de.ts';
import realmEs from '../realm/messages/es.ts';
import realmFr from '../realm/messages/fr.ts';
import realmJa from '../realm/messages/ja.ts';
import realmKo from '../realm/messages/ko.ts';
import realmZhHans from '../realm/messages/zh-Hans.ts';
import realmZhHant from '../realm/messages/zh-Hant.ts';
import { siteHref } from '../realm/route.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import { messages as shellMessages } from '../shell/messages.ts';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { messages as zoneMessages, type ZoneMessages } from './messages.ts';
import zoneDe from './messages/de.ts';
import zoneEs from './messages/es.ts';
import zoneFr from './messages/fr.ts';
import zoneJa from './messages/ja.ts';
import zoneKo from './messages/ko.ts';
import zoneZhHans from './messages/zh-Hans.ts';
import zoneZhHant from './messages/zh-Hant.ts';
import { ZonePageMissing } from './page-missing.tsx';
import { savedSiteCuts } from './site-cuts.ts';
import { MemberList, ZoneDocumentHome } from './site-pages.tsx';
import { zoneTheme } from './theme.ts';
import { ZoneFrame, ZoneMasthead } from './zone-frame.tsx';
import { ZoneHome } from './zone-home.tsx';
import {
  readZoneSiteRecorded,
  zoneSitePrefix,
  type ZoneSiteCredit,
  type ZoneSiteRecordedLoad,
} from './zone-site-recorded-page.ts';

const zoneOverlays = new Map<UiLocale, Partial<ZoneMessages>>([
  ['zh-Hant', zoneZhHant], ['zh-Hans', zoneZhHans], ['ja', zoneJa], ['ko', zoneKo],
  ['de', zoneDe], ['fr', zoneFr], ['es', zoneEs],
]);
const realmOverlays = new Map<UiLocale, Partial<RealmMessages>>([
  ['zh-Hant', realmZhHant], ['zh-Hans', realmZhHans], ['ja', realmJa], ['ko', realmKo],
  ['de', realmDe], ['fr', realmFr], ['es', realmEs],
]);
const siteAddressDiscrepancy = 'presentation address is not a site address';
const refusalAddressDiscrepancy = 'missing-path refusal has no recorded site address';
const presentationDiscrepancy = 'zone site page has no presentation answer';

/** Recorded rights basis and author. No new label: the answer's own words are the credit. */
export function ZoneSiteRecordedCredit({ credit }: { credit: ZoneSiteCredit }) {
  return <PageContainer className="pt-0">
    <p className="break-all text-sm text-muted-foreground">{credit.rightsBasis}</p>
    <p className="break-all text-sm text-muted-foreground">{credit.author}</p>
  </PageContainer>;
}

function siteAddress(address: { prefix: string; key: string; suffixSource: string }): CanonicalAddress | null {
  if (address.prefix !== zoneSitePrefix) return null;
  return { prefix: zoneSitePrefix, key: address.key, suffixSource: address.suffixSource };
}

function siteZone(presentation: ZonePresentationRead, locale: UiLocale, ref: string): ZoneContext {
  return {
    slug: presentation.official,
    realm: null,
    name: zoneContentText(presentation.name ?? presentation.address.suffixSource, presentation.language),
    description: null,
    icon: null,
    hero: null,
    tokens: presentation.presentation.tokens,
    locale,
    links: {
      home: siteHref(locale, ref, []),
      browse: siteHref(locale, ref, ['browse']),
      works: siteHref(locale, ref, ['browse']),
      discussions: '',
      decisions: '',
      about: '',
    },
  };
}

function RecordedSiteFrame({ presentation, locale, homeLabel, children }: {
  presentation: ZonePresentationRead;
  locale: UiLocale;
  homeLabel: string;
  children: ReactNode;
}) {
  const site = siteAddress(presentation.address);
  if (!site) return <p role="alert">{siteAddressDiscrepancy}</p>;
  const ref = addressKey(site);
  const zone = siteZone(presentation, locale, ref);
  const cuts = savedSiteCuts(
    { tokens: zone.tokens, navigation: presentation.presentation.navigation },
    presentation.navigation.map(mount => ({ segment: mount.segment, name: zoneText(mount.name) })),
    ref,
    locale,
    homeLabel,
  );
  const theme = zoneTheme(cuts.tokens, { reader: 'system', enabled: true });
  return <ZoneFrame zone={zone} dataZone={presentation.zone} theme={theme} pkg={null}
    masthead={<ZoneMasthead zone={zone} members={null} actions={null} />} actions={null} members={null} tabs={null}
    site={{ label: zone.name.value, links: cuts.navigation }}>
    {children}
  </ZoneFrame>;
}

function RecordedBody({ load, locale }: { load: ZoneSiteRecordedLoad; locale: UiLocale }) {
  const zones = { ...zoneMessages, ...zoneOverlays.get(locale) };
  const homeLabel = { ...realmMessages, ...realmOverlays.get(locale) }.home;
  const mapped = load.mapped;
  if (mapped.kind === 'discrepancy' || mapped.kind === 'unavailable') {
    return <p role="alert">{mapped.kind === 'discrepancy' ? mapped.detail : mapped.failure}</p>;
  }
  if (mapped.kind === 'refusal') {
    const address = load.address ? siteAddress(load.address.canonical) : null;
    if (!address) return <p role="alert">{refusalAddressDiscrepancy}</p>;
    return <ZonePageMissing title={zones.pageMissingTitle} body={zones.pageMissingBody} back={zones.pageMissingBack}
      href={spaceHref(address, 'site')} />;
  }
  const presentation = load.presentation;
  if (!presentation) return <p role="alert">{presentationDiscrepancy}</p>;
  const site = siteAddress(presentation.address);
  if (!site) return <p role="alert">{siteAddressDiscrepancy}</p>;
  const zone = siteZone(presentation, locale, addressKey(site));
  if (mapped.kind === 'empty') {
    return <RecordedSiteFrame presentation={presentation} locale={locale} homeLabel={homeLabel}>
      <ZoneHome modules={[]} zone={zone} pkg={null} locale={locale} messages={zones}
        empty={<PageContainer><MemberList members={[]} /></PageContainer>} />
    </RecordedSiteFrame>;
  }
  return <RecordedSiteFrame presentation={presentation} locale={locale} homeLabel={homeLabel}>
    <ZoneDocumentHome page={mapped.page} modules={[]} zone={zone} pkg={null} locale={locale} messages={zones} />
    {mapped.credit ? <ZoneSiteRecordedCredit credit={mapped.credit} /> : null}
  </RecordedSiteFrame>;
}

/** One recorded Zone site: the selections name the answers, and the shared mapping decides the page. */
export function ZoneSiteRecordedPage({ record, persona, selections, locale }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  locale: UiLocale;
}) {
  const [load, setLoad] = useState<ZoneSiteRecordedLoad | null>(null);
  useEffect(() => {
    let mounted = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    void readZoneSiteRecorded(replay.fetcher, record, persona, selections).then(result => {
      if (mounted) setLoad(result);
    }).catch((error: unknown) => {
      if (!mounted || (error instanceof DOMException && error.name === 'AbortError')) return;
      setLoad({
        mapped: { kind: 'discrepancy', detail: error instanceof Error ? error.message : String(error) },
        presentation: null,
        address: null,
      });
    });
    return () => { mounted = false; replay.dispose(); };
  }, [record, persona, selections]);
  if (!load) return <p role="status" aria-busy="true">{shellMessages.loading}</p>;
  return <RecordedBody load={load} locale={locale} />;
}
