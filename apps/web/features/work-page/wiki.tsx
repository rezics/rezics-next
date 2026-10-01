import { buttonVariants } from '@rezics/ui/button';
import { BookMarkedIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { entityHref } from '../entity-page/route.ts';
import type { RelationsPage } from '../entity-page/types.ts';
import Link from '../shell/localized-link.tsx';
import { SummaryLink } from '../work-levels/names.tsx';
import { copyOf } from '../work-levels/messages.ts';
import { hubAnchors } from './hub.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import type { Loaded } from './types.ts';
import { mainCharacters, wikiHref, wikiRoutes } from './wiki.ts';

// "Explore the wiki": the Work's wiki Zone is its deep end. The section names where the wiki is, shows the
// Work's main characters as far as the reader has read, and links the Zone's characters, chapter guide and
// timeline. Main answers every read at the reader's position, so what a reader has not reached is absent here.

/** What the section needs from Main: the Zone the Work's statements name and its relations. */
export interface WikiRead {
  /** The wiki Zone's Realm; null when the Work names none. */
  zone: Loaded<string | null>;
  /** The Work's relations, read only when it has a wiki. */
  characters: Loaded<RelationsPage> | null;
}

const MAIN_CHARACTERS = 8;

const link = buttonVariants({ variant: 'outline', size: 'sm', pill: true });

export function WikiSectionView({ wiki, locale, messages }: {
  wiki: WikiRead; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const title = t.sectionWiki;
  if (!wiki.zone.ok) {
    return <Region id="work-wiki" title={title}>
      <RegionFailure title={t.wikiUnavailable} failure={wiki.zone.failure} messages={messages} /></Region>;
  }
  const realm = wiki.zone.data;
  if (!realm) {
    return <Region id="work-wiki" title={title}>
      <p className="text-muted-foreground text-sm">{t.wikiNone}</p>
    </Region>;
  }
  const characters = wiki.characters?.ok ? mainCharacters(wiki.characters.data, MAIN_CHARACTERS) : [];
  const levels = copyOf(locale);
  return <Region id="work-wiki" title={title}>
    {wiki.characters && !wiki.characters.ok
      ? <RegionFailure title={t.wikiUnavailable} failure={wiki.characters.failure} messages={messages} />
      : <div className="grid gap-2">
        <h3 className="font-medium text-sm">{t.wikiMainCharacters}</h3>
        {characters.length ? <ul aria-label={t.wikiMainCharacters} data-wiki-characters
          className="flex flex-wrap gap-2">
          {characters.map(character => <li key={character.reference}
            className="rounded-full border border-border/70 px-3 py-1 text-sm">
            <SummaryLink summary={character} unavailable={levels.unavailable} unnamed={levels.unnamed}
              hrefFor={summary => entityHref(summary.reference)} /></li>)}
        </ul> : <p data-wiki-withheld className="text-muted-foreground text-sm">{t.wikiWithheld}</p>}
        <p className="text-muted-foreground text-xs">{t.wikiPosition}</p>
      </div>}
    <nav aria-label={t.sectionWiki} className="flex flex-wrap gap-2">
      {wikiRoutes.map(route => <Link key={route.key} href={wikiHref(realm, route.path)} className={link}>
        {route.key === 'characters' ? t.wikiCharacters : route.key === 'chapterGuide' ? t.wikiChapterGuide
          : t.wikiTimeline}</Link>)}
      <Link href={wikiHref(realm)} className={buttonVariants({ size: 'sm', pill: true })}>
        <BookMarkedIcon aria-hidden="true" />{t.wikiOpen}</Link>
    </nav>
  </Region>;
}

/** A shortcut near the header; drawn only when the Work has a wiki. */
export function WikiShortcutView({ realm, locale, messages }: { realm: string | null; locale: UiLocale;
  messages: WorkPageMessages }) {
  if (!realm) return null;
  const t = materializeData(messages, { locale });
  return <div><a href={`#${hubAnchors.wiki}`} className={buttonVariants({ variant: 'ghost', size: 'sm', pill: true })}>
    <BookMarkedIcon aria-hidden="true" />{t.wikiShortcut}</a></div>;
}
