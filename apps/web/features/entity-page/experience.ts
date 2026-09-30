import { type Presentation, type PrimaryAction, typeEntry } from '../catalogue/types.ts';
import type { EntityProjection } from './types.ts';

/** The type sections a Work page can lay out; each is a section id of `entity-page-v1`. */
export const typeSectionIds = ['recipe', 'prompt', 'skill'] as const;
export type TypeSectionId = (typeof typeSectionIds)[number];

/** What a Work page leads with. `plain` is every type without a task-focused page: it draws no book controls. */
export type ExperienceKind = 'book' | TypeSectionId | 'guide' | 'plain';

export interface WorkExperience {
  kind: ExperienceKind;
  presentation: Presentation;
  primaryAction: PrimaryAction;
  /** The projection's own link for the recipe, prompt or skill section; null for every other kind. */
  typeSection: { id: TypeSectionId; href: string } | null;
}

/**
 * The page a Work gets, from its `entity-page-v1` projection: the registry
 * entry the projection names and the type section it lists. When Main cannot
 * serve the projection the registry's entry for the Work's types stands in and
 * no type section is offered, so the page shows less rather than a guess. An
 * unknown type reads as the Work default, which is never a book.
 */
export function workExperience(page: EntityProjection | null, types: readonly string[]): WorkExperience {
  const entry = page?.registry ?? typeEntry(types);
  const presentation = entry?.presentation ?? 'default';
  const primaryAction = entry?.primaryAction ?? 'read';
  const section = page?.sections.find(candidate => (typeSectionIds as readonly string[]).includes(candidate.id));
  const typeSection = section ? { id: section.id as TypeSectionId, href: section.href } : null;
  const kind: ExperienceKind = typeSection ? typeSection.id
    : presentation === 'book' ? 'book' : presentation === 'guide' ? 'guide' : 'plain';
  return { kind, presentation, primaryAction, typeSection };
}

/** Book controls (the reader's Read button and its cover layout) belong to the registry's book presentation only. */
export const showsBookControls = (experience: Pick<WorkExperience, 'kind'>) => experience.kind === 'book';
