import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { useSession } from '../../session/query';
import { subjectHref } from '../../subject/subject-href';
import { AuthoredFieldEntry } from './authored-field-entry';
import { CreateSubjectEntry } from './create-subject-entry';
import { GameProfileEntry } from './game-profile-entry';
import { PublicationEditorEntry } from './publication-editor-entry';
import { MangaProfileEntry } from './manga-profile-entry';
import { PeopleProfileEntry } from './people-profile-entry';
import { ProducerHistoryEntry } from './producer-history/entry';
import { RecipeEditorEntry } from './recipe-editor-entry';
import { CharacterProfileEntry } from './character-profile-entry';
import { ScreenProfileEntry } from './screen-profile-entry';
import { AddonProfileEntry } from './addon-profile-entry';
import { StoryArcProfileEntry, storyArcEntry } from './story-arc-profile-entry';
import { LiteraryProfileEntry } from './literary-profile-entry';
import { AlbumProfileEntry } from './album-profile-entry';
import { SubjectFactsEntry } from './subject-facts-entry';
import { SubjectTermsEntry } from './subject-terms-entry';
import { SubjectChangesLink } from './subject-changes-link';
import {
  catalogueEntries,
  contributionHref,
  subjectContributionEntries,
  type CatalogueEntry,
  type ContributionGroup,
} from './catalogue-entry';

function match<Props>(
  node: ReactNode,
  component: (props: Props) => ReactNode,
  describe: (props: Props) => CatalogueEntry,
): CatalogueEntry | undefined {
  return isValidElement<Props>(node) && node.type === component ? describe(node.props) : undefined;
}

/** Consume the existing action slot, retaining its conditions and any unrelated native actions. */
export function collectEditorialEntries(children: ReactNode): { entries: CatalogueEntry[]; retained: ReactNode[] } {
  const entries: CatalogueEntry[] = [];
  const retained: ReactNode[] = [];
  Children.forEach(children, (node) => {
    if (isValidElement<{ children: ReactNode }>(node) && node.type === Fragment) {
      const nested = collectEditorialEntries(node.props.children);
      entries.push(...nested.entries);
      retained.push(...nested.retained);
      return;
    }
    if (isValidElement<Parameters<typeof GameProfileEntry>[0]>(node) && node.type === GameProfileEntry) {
      const entry = catalogueEntries.gameProfile(node.props);
      if (entry) entries.push(entry);
      return;
    }
    const entry =
      match(node, PeopleProfileEntry, catalogueEntries.people) ??
      match(node, ProducerHistoryEntry, catalogueEntries.producerHistory) ??
      match(node, CreateSubjectEntry, catalogueEntries.create) ??
      match(node, AuthoredFieldEntry, catalogueEntries.authored) ??
      match(node, SubjectFactsEntry, catalogueEntries.facts) ??
      match(node, SubjectTermsEntry, catalogueEntries.terms) ??
      match(node, MangaProfileEntry, catalogueEntries.manga) ??
      match(node, RecipeEditorEntry, catalogueEntries.recipe) ??
      match(node, CharacterProfileEntry, catalogueEntries.character) ??
      match(node, ScreenProfileEntry, catalogueEntries.screen) ??
      match(node, AddonProfileEntry, catalogueEntries.addon) ??
      match(node, StoryArcProfileEntry, storyArcEntry) ??
      match(node, LiteraryProfileEntry, catalogueEntries.literary) ??
      match(node, AlbumProfileEntry, catalogueEntries.album) ??
      match(node, PublicationEditorEntry, catalogueEntries.publication) ??
      match(node, SubjectChangesLink, catalogueEntries.changes);
    if (entry) entries.push(entry);
    else if (node != null) retained.push(node);
  });
  return { entries, retained };
}

export function contributionMenu(entries: CatalogueEntry[], locale: string, signedOut: boolean): MenuEntry[] {
  const o = { locale: locale as never };
  const groups: { group: ContributionGroup; label: string }[] = [
    { group: 'create', label: m.contribute_create({}, o) },
    { group: 'edit', label: m.contribute_edit({}, o) },
    { group: 'review', label: m.contribute_review({}, o) },
    { group: 'read', label: m.contribute_read({}, o) },
  ];
  return groups.flatMap(({ group, label }) => {
    const links = entries.filter((entry) => entry.group === group);
    return links.length
      ? [
          {
            type: 'submenu' as const,
            label,
            entries: links.map((entry) => ({
              type: 'link' as const,
              label: entry.label,
              href: contributionHref(entry, signedOut),
            })),
          },
        ]
      : [];
  });
}

/** One existing-shell entry; navigation performs no producer reads or permission mirroring. */
export function EditorialEntry({
  children,
  id,
  label,
  locale,
  context,
  realm,
}: {
  children: ReactNode;
  id: string;
  label: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
}) {
  const { state } = useSession();
  const collected = collectEditorialEntries(children);
  const entries = [...collected.entries, ...subjectContributionEntries({ id, label, locale, context, realm })];
  entries.push(storyArcEntry({ locale, realm }));
  entries.push({
    group: 'edit',
    label: m.identifiers_title({}, { locale: locale as never }),
    href: `${subjectHref({ id, label }, locale).href}/identifiers`,
  });
  const o = { locale: locale as never };
  return (
    <>
      {collected.retained}
      <span data-slot="subject-contribute">
        <Menu
          title={m.contribute_title({}, o)}
          backLabel={m.contribute_back({}, o)}
          trigger={
            <Button variant="outline" size="sm" className="min-h-11">
              {m.contribute_title({}, o)}
            </Button>
          }
          entries={contributionMenu(entries, locale, state === 'signed-out')}
        />
      </span>
    </>
  );
}
