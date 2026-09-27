import { t } from 'elysia';
import type { Static } from 'typebox';
import { readAvatar, readId, readLanguage, readName, readPosition } from '../work/read-contract.ts';
import { realmDirectoryItem } from '../realm-directory/contract.ts';

export const homeInterestKind = t.Union([t.Literal('books'), t.Literal('software'),
  t.Literal('ai'), t.Literal('recipes'), t.Literal('media'), t.Literal('discussions')]);
export type HomeInterestKind = Static<typeof homeInterestKind>;
export const interestsQuery = t.Object({ locale: t.Optional(readLanguage) }, { additionalProperties: false });
export const interestsResult = t.Object({ profile: t.Literal('home-interests-v1'),
  kinds: t.Array(t.Object({ id: homeInterestKind, available: t.Boolean() }), { maxItems: 6 }),
  languages: t.Array(readLanguage, { maxItems: 8 }),
  topics: t.Array(t.Object({ sense: readId, name: readName,
    sampleCovers: t.Array(readAvatar, { maxItems: 3 }) }), { maxItems: 8 }),
  topicsStatus: t.Union([t.Literal('curated'), t.Literal('empty')]), sourcePosition: readPosition });
export const suggestionsQuery = t.Object({ interests: t.Optional(t.String({ maxLength: 100 })),
  languages: t.Optional(t.String({ maxLength: 100 })), actingSubject: t.Optional(readId),
  locale: t.Optional(readLanguage) }, { additionalProperties: false });
const sampleWork = t.Object({ id: readId, title: readName, cover: readAvatar });
export const suggestedFollow = t.Object({ id: readId,
  kind: t.Union([t.Literal('realm'), t.Literal('zone')]), realm: readId,
  name: readName, icon: readAvatar, membership: realmDirectoryItem.properties.membership,
  reason: t.Object({ kind: t.Union([t.Literal('popular'), t.Literal('matching-kind'),
    t.Literal('official')]), interest: t.Nullable(homeInterestKind) }),
  sampleWorks: t.Array(sampleWork, { maxItems: 3 }) });
export const suggestionsResult = t.Object({ profile: t.Literal('home-suggested-follows-v1'),
  items: t.Array(suggestedFollow, { maxItems: 6 }), sourcePosition: readPosition });
/** One directory page, at most eight Realm Work pages, one bounded kind read
 * and at most one discussion probe per Realm, plus one official Zone directory. */
export const ONBOARDING_COST = { realms: 8, samples: 3, suggestions: 3, interestRows: 120 } as const;
