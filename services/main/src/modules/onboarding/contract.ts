import { t } from 'elysia';
import type { Static } from 'typebox';
import { realmDirectoryItem } from '../realm-directory/contract.ts';
import { readAvatar, readId, readLanguage, readName, readPosition } from '../work/read-contract.ts';

const closed = { additionalProperties: false } as const;

/**
 * A new reader's first choices (docs/plan/frontend.md, Home: "Never empty"):
 * content languages, then the shared scheme's Concepts grouped by the type of
 * the public Works that carry them, each with covers so a choice means
 * something. One read of at most 48 scheme Concepts, one of at most four
 * sample Works per Concept (each Work with its types), and two summary
 * batches: 24 Concepts and 64 sample Works.
 */
export const CHOICES_COST = { schemeConcepts: 48, samplesPerConcept: 4, shownConcepts: 24, shownSamples: 3,
  sampleWorks: 64, workTypes: 3, groups: 8, groupConcepts: 12 } as const;

export const choicesQuery = t.Object({ locale: t.Optional(readLanguage) }, closed);
const sampleWork = t.Object({ id: readId, title: readName, cover: readAvatar });
export const choiceConcept = t.Object({ id: readId, name: readName,
  /** The broader Concept in the same scheme, when it is offered too, so a reader can refine. */
  broader: t.Nullable(readId),
  samples: t.Array(sampleWork, { maxItems: CHOICES_COST.shownSamples }) });
export const onboardingChoices = t.Object({ profile: t.Literal('onboarding-choices-v1'),
  /** Content languages a reader can choose, the requested locale's first. */
  languages: t.Array(readLanguage, { maxItems: 8 }),
  /** One group per Work type, in the order a reader meets them: the type with most Concepts first. */
  groups: t.Array(t.Object({ type: t.String(), concepts: t.Array(choiceConcept, { maxItems: CHOICES_COST.groupConcepts }) }),
    { maxItems: CHOICES_COST.groups }),
  sourcePosition: readPosition });
export type OnboardingChoices = Static<typeof onboardingChoices>;

/** Concepts and languages the reader chose; with neither, the suggestions are popular Realms. */
export const suggestionsQuery = t.Object({
  concepts: t.Optional(t.Array(readId, { minItems: 1, maxItems: 8, uniqueItems: true })),
  languages: t.Optional(t.Array(readLanguage, { minItems: 1, maxItems: 8, uniqueItems: true })),
  actingSubject: t.Optional(readId), locale: t.Optional(readLanguage) }, closed);
export const suggestionReason = t.Union([
  /** A sample Work carries the Concept, or a narrower one in its scheme. */
  t.Object({ kind: t.Literal('matching-concept'), concept: t.Object({ id: readId, name: t.Nullable(readName) }) }),
  /** Active on REZICS; `language` when its Works are in a language the reader reads. */
  t.Object({ kind: t.Literal('popular'), language: t.Optional(readLanguage) }),
]);
export type SuggestionReason = Static<typeof suggestionReason>;
export const suggestedFollow = t.Object({ id: readId,
  kind: t.Union([t.Literal('realm'), t.Literal('zone')]), realm: readId,
  name: readName, icon: readAvatar, membership: realmDirectoryItem.properties.membership,
  reason: suggestionReason, sampleWorks: t.Array(sampleWork, { maxItems: 3 }) });
export const suggestionsResult = t.Object({ profile: t.Literal('home-suggested-follows-v2'),
  items: t.Array(suggestedFollow, { maxItems: 6 }), sourcePosition: readPosition });

/** One activity directory page, at most four non-official and eight official
 * Realm candidates. Each reads at most eight adopted Works and, when Concepts
 * are chosen, one bounded match of those Works' accepted Concepts. */
export const SUGGESTION_COST = { realms: 8, nonOfficialRealms: 4, officialRealms: 8, workScan: 8,
  samples: 3, suggestions: 3, conceptRows: 128 } as const;

/** The content languages Home filters by: the interface locales' writing systems. */
export const contentLanguages = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const;
