import { storyId } from '../feed/fixtures.ts';
import type { OnboardingChoices } from '../feed/types.ts';
import { suggestions } from '../home/fixtures.ts';
import type { WelcomeApi } from './welcome-api.ts';

// Story and test data for the first-minute setup: what Main offers, and an
// in-memory Main that records the one follow command and the settings write.

const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });
const cover = (key: string) => ({ kind: 'fallback' as const, policy: 'avatar-fallback-v1', key, resourceType: 'work' });
const sample = (n: number, title: string, language = 'en') => ({ id: storyId(n, 'cccc'), title: name(title, language),
  cover: cover(`sample-${n}`) });
const topic = (n: number, label: string, samples: ReturnType<typeof sample>[], broader: number | null = null,
  language = 'en') => ({ id: storyId(n, 'eeee'), name: name(label, language),
  broader: broader === null ? null : storyId(broader, 'eeee'), samples });

export const choices: OnboardingChoices = {
  profile: 'onboarding-choices-v1', languages: ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'],
  sourcePosition: { dataEpoch: 'story', sequence: '1' },
  groups: [
    { type: 'https://schema.org/Book', concepts: [
      topic(311, 'Fantasy', [sample(1, 'The Last Lantern'), sample(2, '雨夜书店', 'zh-Hans'), sample(3, 'Alice')]),
      topic(312, '仙侠', [sample(4, '月下仙途', 'zh-Hans')], 311, 'zh-Hans'),
      topic(313, 'Mystery', [sample(5, 'Sherlock Holmes'), sample(6, 'The Moonstone')]),
      topic(315, 'Romance', [sample(7, 'Pride and Prejudice')]),
    ] },
    { type: 'https://schema.org/BookSeries', concepts: [topic(311, 'Fantasy', [sample(8, 'Discworld')])] },
    { type: 'https://schema.org/VideoGame', concepts: [topic(314, 'Cozy games', [sample(9, 'Stardew Valley')])] },
    { type: 'https://schema.org/Recipe', concepts: [topic(316, 'Weeknight dinners', [sample(10, 'Scallion pancakes')])] },
  ],
};

export type MemoryWelcome = WelcomeApi & { calls: string[] };

export function memoryWelcome(options: { refuse?: boolean } = {}): MemoryWelcome {
  const calls: string[] = [];
  return {
    calls,
    async suggestions(input) {
      calls.push(`suggestions:${input.concepts.length}:${input.languages.join(',')}`);
      return { ok: true, data: suggestions };
    },
    async saveLanguages(languages) {
      calls.push(`languages:${languages.join(',')}`);
      return !options.refuse;
    },
    async follow(targets) {
      calls.push(`follow:${targets.map(item => item.kind).join(',')}`);
      return !options.refuse;
    },
  };
}
