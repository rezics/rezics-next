'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import type { UiLocale } from '../../i18n/define.ts';
import { surfaceText } from '../address/messages.ts';
import { BFF_PREFIX } from '../api/browser.ts';
import { signInPath } from '../auth/paths.ts';
import { ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import { zoneText } from '../realm/adapt.ts';
import type { RealmMessages } from '../realm/messages.ts';
import { RealmMembership } from '../realm/membership.tsx';
import { realmHref, siteHref } from '../realm/route.ts';
import { realmMessagesFor } from '../realm/story-page.tsx';
import { messages as shellMessages } from '../shell/messages.ts';
import shellJa from '../shell/messages/ja.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { recordedFetch, type RecordedSelection } from '../stories/recorded-fetch.ts';
import { ZoneHomeContent } from '../zone-editor/home-content.tsx';
import { zoneLookEnabled } from './execution.ts';
import { zoneMessagesFor } from './fixtures.ts';
import { LookMenu } from './look-menu.tsx';
import type { ZoneMessages } from './messages.ts';
import { ZonePageMissing } from './page-missing.tsx';
import { MemberList } from './site-pages.tsx';
import { ZoneSiteRecordedCredit } from './zone-site-recorded-page.tsx';
import { ZoneFrame, ZoneMasthead } from './zone-frame.tsx';
import { loadZoneHomeFrame, recordedZoneHomeClient, zoneHomeFrameModel, type ZoneHomeShown } from './zone-home-recorded-page.tsx';

function HomeFrame({ model, locale, messages, realmMessages, children }: {
  model: Exclude<ZoneHomeShown, { kind: 'missing-standalone' }>;
  locale: UiLocale;
  messages: ZoneMessages;
  realmMessages: RealmMessages;
  children: ReactNode;
}) {
  const here = model.kind === 'missing'
    ? realmHref(locale, model.realmRef ?? model.context.ref)
    : siteHref(locale, model.context.ref, []);
  const signInHref = signInPath(here);
  const actions = model.realmId ? <>
    <RealmMembership realm={model.realmId} realmName={model.zone.name.value} initial={null} signedIn={false}
      signInHref={signInHref} rulesHref={model.zone.links.about} locale={locale} messages={realmMessages} />
    <LocalizedLink href={realmHref(locale, model.realmRef ?? model.context.ref)}
      className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
      {surfaceText.community[locale]}
    </LocalizedLink>
    <LookMenu enabled={zoneLookEnabled(undefined)} labels={{ menu: messages.lookLabel, zone: messages.lookZone, standard: messages.lookStandard,
      help: messages.lookHelp, saveFailed: messages.lookSaveFailed }} />
  </> : null;
  return <ZoneFrame zone={model.zone} dataZone={model.dataZone} theme={model.theme} pkg={null} actions={actions}
    members={null} masthead={<ZoneMasthead zone={model.zone} members={null} actions={actions} />} tabs={null}
    site={{ label: model.siteLabel, links: model.links }}>
    <ReaderActionsProvider signedIn={false} signInHref={signInHref}>{children}</ReaderActionsProvider>
  </ZoneFrame>;
}

/** The production Zone home, fed by a replaying client. The story file chooses the samples. */
export function ZoneHomeRecordedPage({ record, persona, selections, space, locale, routePath }: {
  record: AnswerRecord;
  persona: AnswerPersona;
  selections: readonly RecordedSelection[];
  space: string;
  locale: UiLocale;
  routePath?: string;
}) {
  const [shown, setShown] = useState<ReactNode>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const replay = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX, locale });
    const main = recordedZoneHomeClient(replay.fetcher);
    async function load() {
      const loaded = await loadZoneHomeFrame(main, space, locale, routePath);
      const messages = zoneMessagesFor(locale);
      const realmMessages = realmMessagesFor(locale);
      const model = zoneHomeFrameModel(loaded, locale, realmMessages.home);
      if (model.kind === 'missing' || model.kind === 'missing-standalone') {
        if (!model.backHref) throw new Error('Recorded missing page has no site address');
        const missing = <ZonePageMissing title={messages.pageMissingTitle} body={messages.pageMissingBody}
          back={messages.pageMissingBack} href={model.backHref} />;
        if (!active) return;
        setShown(model.kind === 'missing-standalone' ? missing
          : <HomeFrame model={model} locale={locale} messages={messages} realmMessages={realmMessages}>{missing}</HomeFrame>);
        return;
      }
      const empty = <PageContainer>
        <MemberList members={model.presentation.navigation.map(item => ({
          id: item.target, href: siteHref(locale, model.context.ref, [item.segment]),
          name: zoneText(item.name), kind: null,
        }))} />
      </PageContainer>;
      const content = await ZoneHomeContent({
        page: model.page, presentation: model.presentation.presentation, moduleData: model.presentation.moduleData,
        slideMedia: model.presentation.slideMedia, context: model.context, zone: model.zone, pkg: null, messages,
        empty: model.page ? undefined : empty,
      });
      if (!active) return;
      setShown(<HomeFrame model={model} locale={locale} messages={messages} realmMessages={realmMessages}>
        {content}
        {model.credit ? <ZoneSiteRecordedCredit credit={model.credit} /> : null}
      </HomeFrame>);
    }
    void load().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason : new Error(String(reason)));
    });
    return () => { active = false; replay.dispose(); };
  }, [record, persona, selections, space, locale, routePath]);
  if (error) throw error;
  if (!shown) return <PageContainer><p role="status" aria-busy="true">{locale === 'ja' ? shellJa.loading : shellMessages.loading}</p></PageContainer>;
  return shown;
}
