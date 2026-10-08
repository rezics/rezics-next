import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { readEntityProjection, readRelations, readStatements, sectionOf } from '../entity-page/read.ts';
import type { RelationsPage } from '../entity-page/types.ts';
import type { WorkPageMessages } from './messages.ts';
import type { Loaded } from './types.ts';
import { wikiZoneRead } from './wiki.ts';
import { WikiSectionView, WikiShortcutView } from './wiki.tsx';

// The wiki section's reads: the Zone a Work's statements name, then its relations. Stories draw the views alone.

/** The Zone a Work's statements name, read once per request for the shortcut and the section. */
const readWikiZone = cache(async (id: string): Promise<Loaded<string | null>> => {
  const page = await readEntityProjection(id);
  const statements = page.ok ? sectionOf(page.data, 'statements') : undefined;
  return wikiZoneRead(page, statements ? await readStatements(statements, undefined) : undefined);
});

export async function WikiSection({ id, locale, messages }: { id: string; locale: UiLocale; messages: WorkPageMessages }) {
  const zone = await readWikiZone(id);
  let characters: Loaded<RelationsPage> | null = null;
  if (zone.ok && zone.data) {
    const page = await readEntityProjection(id);
    const relations = page.ok ? sectionOf(page.data, 'relations') : undefined;
    characters = relations ? await readRelations(relations, undefined) : null;
  }
  return <WikiSectionView wiki={{ zone, characters }} locale={locale} messages={messages} />;
}

export async function WikiShortcut({ id, locale, messages }: { id: string; locale: UiLocale; messages: WorkPageMessages }) {
  const zone = await readWikiZone(id);
  return <WikiShortcutView realm={zone.ok ? zone.data : null} locale={locale} messages={messages} />;
}
