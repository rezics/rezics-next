import type { WorkCoverKind } from '@rezics/ui/work-cover';
import { coverKindOf } from '../catalogue/work.ts';
import type { OnboardingChoices } from '../feed/types.ts';
import type { OnboardingMessages } from './messages.ts';

// The setup's topic step, shared by the flow, its stories and tests.

type Group = OnboardingChoices['groups'][number];
export type Topic = Group['concepts'][number];

/** At most as many topics as Home has tabs, so every chosen topic is pinned. */
export const MAX_TOPICS = 8;

/**
 * The heading for Main's type groups. Main names the group by its Work type
 * and serves no label for types yet, so these follow the catalogue's own type
 * words; a type Home does not know reads as a general heading.
 */
const headings: Record<string, keyof OnboardingMessages> = {
  'https://schema.org/Book': 'typeBooks', 'https://schema.org/BookSeries': 'typeBooks',
  'https://schema.org/VideoGame': 'typeGames',
  'https://schema.org/SoftwareApplication': 'typeSoftware', 'https://schema.org/SoftwareSourceCode': 'typeSoftware',
  'https://rezics.com/vocab/ModPackage': 'typeMods', 'https://schema.org/Recipe': 'typeRecipes',
  'https://rezics.com/vocab/PromptTemplate': 'typePrompts', 'https://rezics.com/vocab/SkillPackage': 'typeSkills',
  'https://schema.org/Movie': 'typeScreen', 'https://schema.org/TVSeries': 'typeScreen',
  'https://schema.org/VideoObject': 'typeVideo', 'https://schema.org/MusicAlbum': 'typeMusic',
  'https://schema.org/MusicRecording': 'typeMusic', 'https://schema.org/AudioObject': 'typeMusic',
  'https://schema.org/DigitalDocument': 'typeGuides',
};

export interface TopicGroup {
  heading: keyof OnboardingMessages;
  /** How this group's example covers are drawn. */
  cover: WorkCoverKind;
  topics: Topic[];
}

/**
 * Main's groups under the reader's headings: types that read the same (a Book
 * and a book series) share one group, and a topic appears once per group.
 */
export function topicGroups(groups: readonly Group[]): TopicGroup[] {
  const merged = new Map<keyof OnboardingMessages, TopicGroup>();
  for (const group of groups) {
    const heading = headings[group.type] ?? 'typeGuides';
    const entry = merged.get(heading) ?? { heading, cover: coverKindOf([group.type]), topics: [] };
    for (const topic of group.concepts) {
      if (!entry.topics.some(item => item.id === topic.id)) entry.topics.push(topic);
    }
    merged.set(heading, entry);
  }
  return [...merged.values()];
}

/** The broader topic's name, when Main offers it too, so "Xianxia" reads "in Fantasy". */
export function broaderName(groups: readonly TopicGroup[], topic: Topic): string | null {
  if (!topic.broader) return null;
  for (const group of groups) {
    const broader = group.topics.find(item => item.id === topic.broader);
    if (broader) return broader.name.value;
  }
  return null;
}

/** The chosen set after toggling a topic; a ninth is refused rather than dropping another. */
export function toggled(chosen: readonly string[], topic: string): string[] {
  if (chosen.includes(topic)) return chosen.filter(item => item !== topic);
  return chosen.length >= MAX_TOPICS ? [...chosen] : [...chosen, topic];
}

/**
 * The languages to start the language step from: the reader's saved content
 * languages in their order, else Main's first suggestion (the page's locale).
 */
export function startingLanguages(saved: readonly string[] | null, offered: readonly string[], locale: string): string[] {
  if (saved?.length) return [...saved];
  return offered.includes(locale) ? [locale] : offered.slice(0, 1);
}
