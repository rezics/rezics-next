import type { ReactNode } from 'react';
import { surfaceText } from '../address/messages.ts';
import { realmHref } from '../realm/route.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { zoneTheme, type ReaderTheme } from '../zones/theme.ts';
import { ZoneFrame, ZoneMasthead } from '../zones/zone-frame.tsx';
import type { SavedPreviewFrame } from './saved-preview-frame.ts';

/** Both saved frame modes render the authorized cuts even when no public home is readable. */
export function ZoneSavedPreviewFrame({ frame, readerTheme, nonce, children }: {
  frame: SavedPreviewFrame;
  readerTheme: ReaderTheme;
  nonce?: string;
  children: ReactNode;
}) {
  const { zone, cuts, pkg, saved } = frame;
  const { locale } = frame.context;
  const actions = frame.realmRef ? <LocalizedLink href={realmHref(locale, frame.realmRef)}
    className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">
    {surfaceText.community[locale]}</LocalizedLink> : null;
  return <ZoneFrame zone={zone} dataZone={zone.slug ?? saved.model.zoneId}
    theme={zoneTheme(cuts.tokens, { reader: readerTheme, enabled: true })} pkg={pkg} nonce={nonce}
    members={null} actions={actions} masthead={<ZoneMasthead zone={zone} members={null} actions={actions} />}
    tabs={null} site={{ label: surfaceText.site[locale], links: cuts.navigation }}>
    {children}
  </ZoneFrame>;
}
