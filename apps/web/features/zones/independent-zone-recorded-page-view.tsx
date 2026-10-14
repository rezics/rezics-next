import type { ZoneContext, ZoneTokens } from '@rezics/zone-sdk';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { zoneText } from '../realm/adapt.ts';
import { siteHref } from '../realm/route.ts';
import type { ZonePresentationRead } from '../realm/types.ts';
import { publishedFrameModel, type PublishedFrameModel } from '../realm/zone-presentation-read.ts';
import { PageContainer } from '../shell/page.tsx';
import { ZoneHomeContent } from '../zone-editor/home-content.tsx';
import type { SiteMountCut, SitePresentationCut } from './site-cuts.ts';
import { MemberList } from './site-pages.tsx';
import type { ZoneMessages } from './messages.ts';
import { ZoneFrame, ZoneMasthead } from './zone-frame.tsx';
import type { ZoneSiteMapped } from './zone-site-recorded-page.ts';
import { ZoneSiteRecordedCredit } from './zone-site-recorded-page.tsx';
import type { ReaderTheme } from './theme.ts';

/** The published frame decision. Production supplies the cookie theme and nonce; a story supplies the empty jar. */
export function independentZoneFrameModel(
  presentation: ZonePresentationRead,
  zone: ZoneContext,
  zoneId: string,
  ref: string,
  locale: UiLocale,
  homeName: string,
  theme: ReaderTheme,
  options: {
    mounts?: readonly SiteMountCut[];
    tokens?: ZoneTokens;
    navigation?: SitePresentationCut['navigation'];
  } = {},
): PublishedFrameModel {
  return publishedFrameModel(presentation, zoneId, locale, homeName, '', {
    reader: theme,
    ref,
    zone,
    mounts: options.mounts,
    tokens: options.tokens,
    navigation: options.navigation,
  });
}

/** The standalone frame element. Callers keep their own theme, nonce and edit-site action. */
export function independentZoneSiteFrame(model: PublishedFrameModel, nonce: string | undefined, actions: ReactNode,
  children: ReactNode) {
  const { zone: frameZone, cuts, theme } = model;
  return <ZoneFrame zone={frameZone} dataZone={model.zoneId} theme={theme} pkg={null}
    nonce={nonce} members={null} actions={actions}
    masthead={<ZoneMasthead zone={frameZone} members={null} actions={actions} />} tabs={null}
    site={{ label: frameZone.name.value, links: cuts.navigation }}>
    {children}
  </ZoneFrame>;
}

/** The published home body: the presentation's document through the production home, plus its credit. */
export function independentZoneHomeBody({ mapped, presentation, zone, zoneId, ref, locale, messages }: {
  mapped: Extract<ZoneSiteMapped, { kind: 'published' | 'empty' }>;
  presentation: ZonePresentationRead;
  zone: ZoneContext;
  zoneId: string;
  ref: string;
  locale: UiLocale;
  messages: ZoneMessages;
}) {
  const mounts = presentation.navigation;
  const context = {
    locale, ref, realm: zoneId, zone: zoneId,
    mounts: new Map(mounts.map(mount => [mount.target, mount.segment])),
  };
  if (mapped.kind === 'published') return <>
    <ZoneHomeContent page={mapped.page} presentation={presentation.presentation}
      moduleData={presentation.moduleData} slideMedia={presentation.slideMedia} zone={zone} pkg={null}
      messages={messages} context={context} />
    {mapped.credit ? <ZoneSiteRecordedCredit credit={mapped.credit} /> : null}
  </>;
  return <ZoneHomeContent page={null} presentation={presentation.presentation}
    moduleData={presentation.moduleData} slideMedia={presentation.slideMedia} zone={zone} pkg={null}
    messages={messages} context={context}
    empty={<PageContainer>
      <MemberList members={mounts.map(mount => ({
        id: mount.target,
        href: siteHref(locale, ref, [mount.segment]),
        name: zoneText(mount.name),
        kind: null,
      }))} />
    </PageContainer>} />;
}
