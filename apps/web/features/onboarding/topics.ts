import type { WorkCoverKind } from '@rezics/ui/work-cover';
import type { UiLocale } from '../../i18n/define.ts';
import { coverOf, entryLabel, typeEntry } from '../catalogue/types.ts';
import type { OnboardingChoices } from '../feed/types.ts';
import { topicLoader } from '../discover/topic-picker.tsx';

// The setup's topic step, shared by the flow, its stories and tests.

type Group = OnboardingChoices['groups'][number];
export type Topic = Group['concepts'][number];

/** At most as many topics as Home has tabs, so every chosen topic is pinned. */
export const MAX_TOPICS = 8;

/** Onboarding keeps its curated samples and searches the complete Concept inventory with the shared picker. */
export const onboardingTopicLoader = (locale: UiLocale, actingSubject: string) => topicLoader(locale, actingSubject);

export interface TopicGroup {
  /** The registry's plural word for the group's type ("Books", "Games"), in the reader's language; null without the registry. */
  heading: string | null;
  /** How this group's example covers are drawn. */
  cover: WorkCoverKind;
  topics: Topic[];
}

/**
 * Main's groups under the registry's headings: types the registry words the
 * same (a Book and a book series) share one group, a type it does not know
 * reads as its base's default ("Works"), and a topic appears once per group.
 */
export function topicGroups(groups: readonly Group[], locale: UiLocale): TopicGroup[] {
  const merged = new Map<string, TopicGroup>();
  for (const group of groups) {
    const entry = typeEntry([group.type]);
    // With no registry there is no word for a type, and an IRI is never a heading.
    const heading = entry ? entryLabel(entry, locale, 'other') : null;
    const key = entry ? entry.labels.en.other : '';
    const found = merged.get(key) ?? { heading, cover: coverOf([group.type]), topics: [] };
    for (const topic of group.concepts) {
      if (!found.topics.some(item => item.id === topic.id)) found.topics.push(topic);
    }
    merged.set(key, found);
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
