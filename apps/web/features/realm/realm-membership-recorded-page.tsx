'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import membershipRecord from '../../../../tests/qa/fixtures/outcomes/realm/membership-and-admission.json';
import { privateDiscovery } from '../address/space-page.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import type { MainClient } from '../discover/types.ts';
import { RealmFrame } from '../manage/realm-frame.tsx';
import { RequestsView } from '../manage/requests-view.tsx';
import { messages as manageMessages } from '../manage/messages.ts';
import { spaceAccessApi } from '../manage/settings-api.ts';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { presetTokens } from '../zones/presentation.ts';
import { zoneTheme } from '../zones/theme.ts';
import { ZoneMasthead } from '../zones/zone-frame.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import { PrivateSpaceJoinPage } from '../space-access/join-page.tsx';
import { zoneImage, zoneText } from './adapt.ts';
import { mainMembershipActions, RealmMembership } from './membership.tsx';
import { messages as realmMessages } from './messages.ts';
import { realmHref } from './route.ts';
import { loadRecordedMembership, recordedIdentity, type MembershipSurface, type RecordedMembershipView } from './realm-membership-recorded-page.ts';

const record = membershipRecord as AnswerRecord;
const locale = 'en' as const;

function replayFetcher(replay: ReturnType<typeof recordedFetch>, missed: { current: string | null }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try { return await replay.fetcher(input, init); }
    catch (error) {
      missed.current = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }) as typeof fetch;
}

/** The community or request page, read by the production adapters from one recorded persona. */
export function RecordedMembershipPage({ persona, selections, surface }: {
  persona: AnswerPersona; selections: readonly RecordedSelection[]; surface: MembershipSurface;
}) {
  const key = selections.map(item => `${item.label}:${item.state}`).join('|');
  const [ready, setReady] = useState<{ view: RecordedMembershipView; main: MainClient; fetcher: typeof fetch } | null>(null);
  useEffect(() => {
    setReady(null);
    const missed = { current: null as string | null };
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
    const fetcher = replayFetcher(replay, missed);
    const main = browserMainApi(window.location.origin, { fetcher });
    const identity = recordedIdentity(record, persona, selections);
    let mounted = true;
    void loadRecordedMembership(main, { surface, ...identity, locale, fetcher }, () => missed.current).then(view => {
      if (mounted) setReady({ view, main, fetcher });
    }).catch((error: unknown) => {
      if (!mounted) return;
      throw error;
    });
    return () => { mounted = false; replay.dispose(); };
  }, [persona, surface, key, selections]);
  if (!ready) return <p role="status">{shellMessages.loading}</p>;
  return <RecordedMembershipView view={ready.view} main={ready.main} fetcher={ready.fetcher} />;
}

function RecordedMembershipView({ view, main, fetcher }: {
  view: RecordedMembershipView; main: MainClient; fetcher: typeof fetch;
}) {
  const transport = useMemo(() => ({ fetch: fetcher }), [fetcher]);
  if (view.kind === 'refusal') return <p role="alert">{view.problemTitle}</p>;
  if (view.kind === 'join') {
    const realm = view.page.id.slice(-36);
    return <PrivateSpaceJoinPage page={{ ...view.page, discovery: privateDiscovery(view.page.discovery) }}
      discoveryMetadata={false} persist={false} locale={locale} actingSubject={null}
      signInHref={signInPath(realmHref(locale, realm))} />;
  }
  if (view.kind === 'joined') {
    const { titleEffect: _title, ...tokens } = presetTokens.clean;
    const name = zoneText(view.header.name);
    const realm = view.header.id.slice(-36);
    const zone = { slug: null, realm: view.header.id, name, description: zoneText(view.header.description),
      icon: zoneImage(view.header.icon), hero: zoneImage(view.header.banner), tokens, locale,
      links: { home: realmHref(locale, realm), browse: realmHref(locale, realm, 'browse'),
        works: realmHref(locale, realm, 'works'), discussions: realmHref(locale, realm, 'discussions'),
        decisions: realmHref(locale, realm, 'decisions'), about: realmHref(locale, realm, 'about') } };
    const theme = zoneTheme(tokens, { reader: 'light', enabled: true });
    const actions = <RealmMembership realm={view.header.id} realmName={name.value} initial={view.membership}
      signedIn actingSubject={view.actingSubject} signInHref={signInPath(realmHref(locale, realm))}
      rulesHref={zone.links.about} locale={locale} messages={realmMessages} transport={transport}
      actions={mainMembershipActions(view.header.id, view.actingSubject, transport)} />;
    return <div className={theme.className} style={theme.style}>
      <ZoneMasthead zone={zone} members={null} actions={actions} />
    </div>;
  }
  const acting = view.agent.iri;
  return <RealmFrame realm={view.realm} header={view.header} agent={view.agent} locale={locale} messages={manageMessages}
    settingsAllowed={false} siteHref={view.siteHref}>
    <RequestsView initial={view.page} space={view.space} realm={view.realm} actingSubject={acting} locale={locale}
      api={spaceAccessApi(() => main, view.space, view.realm, acting)} />
  </RealmFrame>;
}
