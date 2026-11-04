import { pickText } from '@rezics/composition';
import type { CollectionMember, LibrarySubject } from '../reads';
import type { Release } from '../../subject/definitions';
import { releasedListPresentation, listKeyFacts } from '../../media/type-presentation';
import { subjectHref } from '../../subject/subject-href';

/** Shared native list facts; the shelf never requests Subject details or reads votes. */
export type ShelfFacts = NonNullable<CollectionMember['facts']>;
export type ShelfEntryIdentity = { subjectId: string; revision: number; incarnationId?: string | null };
export type ShelfContextSource = {
  entryIdentity?: ShelfEntryIdentity | null;
  subjectId: string;
  revision: number;
  incarnationId?: string | null;
  id?: string;
  labelId?: string;
  subject: LibrarySubject | null;
  facts?: ShelfFacts | undefined;
};
export type ShelfWorkContext = {
  identity: string;
  locale: string;
  facts: { property: string; role: string; roleLang?: string; text: string; lang?: string; href?: string }[];
};

function identity(entry: ShelfContextSource): string {
  return JSON.stringify([
    entry.subjectId,
    entry.subject?.id,
    entry.revision,
    entry.incarnationId ?? null,
    entry.id ?? null,
    entry.labelId ?? null,
    entry.entryIdentity?.subjectId ?? null,
    entry.entryIdentity?.revision ?? null,
    entry.entryIdentity?.incarnationId ?? null,
  ]);
}

/**
 * Optional producer seam: FULL personal rows supply facts in Kernel source; its installed client and FULL label
 * assignments do not yet publish them. Absence stays unavailable, without a substitute request or guessed role.
 */
export function suppliedShelfFacts(entry: { subjectId: string; facts?: ShelfFacts }): ShelfFacts | undefined {
  return entry.facts;
}

/** Bind supplied, released facts synchronously to this exact Entry/assignment, before rendering any context. */
export function prepareShelfWorkContext(
  entry: ShelfContextSource,
  release: Release | undefined,
  locale: string,
): ShelfWorkContext | null {
  if (!entry.subject || !release || !entry.facts) return null;
  const presentation = releasedListPresentation(entry.subject.types, release.types);
  if (!presentation) return null;
  const facts: ShelfWorkContext['facts'] = [];
  for (const property of presentation.keyFacts.slice(0, 4)) {
    const definition = Object.hasOwn(release.properties, property) ? release.properties[property] : undefined;
    const role = pickText(definition?.labels ?? {}, locale);
    if (!role.text || !Object.hasOwn(entry.facts, property)) continue;
    for (const value of entry.facts[property]?.slice(0, 3) ?? []) {
      // A supplied role is its released property label, never universal authorship. Only exact item/date facts
      // identify works here; quantities and codes remain with their own presentation owners.
      if (
        !definition ||
        !(
          (value.kind === 'item' && definition.datatype === 'wikibase-item') ||
          (value.kind === 'time' && definition.datatype === 'time')
        )
      )
        continue;
      const formatted = listKeyFacts({ [property]: [value] }, [property], [], locale)[0];
      if (!formatted?.text) continue;
      facts.push({
        property,
        role: role.text,
        ...(role.lang ? { roleLang: role.lang } : {}),
        text: formatted.text,
        ...(formatted.lang ? { lang: formatted.lang } : {}),
        ...(value.kind === 'item' && value.id
          ? { href: subjectHref({ id: value.id, label: formatted.text }, locale).href }
          : {}),
      });
      if (facts.length === 4) return { identity: identity(entry), locale, facts };
    }
  }
  return { identity: identity(entry), locale, facts };
}

/** A command revision, reincarnation, reassignment, concealed Subject or locale change retires its old context. */
export function currentShelfWorkContext(
  entry: ShelfContextSource & { workContext?: ShelfWorkContext | null },
  locale: string,
): ShelfWorkContext | null {
  const context = entry.workContext;
  return entry.subject && context?.locale === locale && context.identity === identity(entry) ? context : null;
}
