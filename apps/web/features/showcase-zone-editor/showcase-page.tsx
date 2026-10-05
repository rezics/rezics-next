import { LayoutPanelTopIcon, LinkIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { ManageFailure, SectionHeader } from '../manage/parts.tsx';
import { realmHref } from '../manage/routes.ts';
import type { MainClient } from '../manage/types.ts';
import { resolveRealm } from '../realm/read.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { messages as pickerMessages } from '../work-levels-edit/messages.ts';
import { messages as editorMessages } from '../showcase-editor/messages.ts';
import { addCampaignArt, readLatestShowcase, readSlideWorks, saveShowcase } from './actions.ts';
import { ZoneShowcaseEditor } from './editor.tsx';
import { copyOf, messages } from './messages.ts';
import { loadSlideWorks, readCampaignRegistry, readZoneShowcase } from './server.ts';

// The server composition of `/manage/r/{realm}/showcase`: the Realm's Zone, its current revision
// and slides, the Works the slides name and the campaign art Main delivers. Management always acts
// as the session Agent; Main still admits the save against the authority to edit the Zone, and the
// editor says so in words when it refuses.

export async function RealmShowcasePage({ address, locale, main, actingSubject, signInHref }: {
  /** How the address names the Realm: its official Zone's segment, or its ID. */
  address: string; locale: UiLocale; main: MainClient; actingSubject: string; signInHref: string;
}) {
  const manageMessages = await getMessages('manage', locale);
  const retryHref = localizedPath(realmHref(address, 'showcase'), locale);
  const t = copyOf(locale);
  const resolved = await resolveRealm(address, locale);
  const header = <SectionHeader id="showcase-heading" title={t.heading} description={t.intro} />;
  if (resolved.kind !== 'realm') return <ManageFailure failure={resolved.kind === 'unavailable' ? 'unavailable' : 'missing'} locale={locale}
    messages={manageMessages} retryHref={retryHref} />;
  if (!resolved.zone) return <section aria-labelledby="showcase-heading" className="grid gap-6">{header}
    <EmptyState icon={LayoutPanelTopIcon} title={t.noZoneTitle} description={t.noZoneBody} headingLevel={3} /></section>;
  const zone = resolved.zone.id;
  const read = await readZoneShowcase(main, zone, actingSubject);
  if (!read.ok) return <ManageFailure failure={read.failure} locale={locale} messages={manageMessages} signInHref={signInHref} retryHref={retryHref} />;
  const { state } = read;
  if (state.presentation.kind === 'reference') return <section aria-labelledby="showcase-heading" className="grid gap-6">{header}
    <EmptyState icon={LinkIcon} title={t.externalTitle} description={t.externalBody} headingLevel={3} /></section>;
  const slides = state.presentation.kind === 'document' ? state.presentation.document.slides : [];
  const [registry, works, zoneMessages] = await Promise.all([
    readCampaignRegistry(zone, actingSubject),
    state.realm ? loadSlideWorks({ realm: state.realm, locale, works: slides.flatMap(slide => slide.work ? [slide.work] : []),
      actingSubject }) : Promise.resolve({}),
    getMessages('zones', locale),
  ]);
  return <section aria-labelledby="showcase-heading" className="grid gap-6">
    {header}
    <ZoneShowcaseEditor zone={zone} realm={state.realm} actingSubject={actingSubject} locale={locale} head={state.revision}
      stored={state.presentation} registry={registry} works={works} heroTitle={zoneMessages.picks} messages={messages[locale]}
      editorMessages={editorMessages[locale]} pickerMessages={pickerMessages[locale]} save={saveShowcase} addArt={addCampaignArt}
      readWorks={readSlideWorks} readLatest={readLatestShowcase} />
  </section>;
}

