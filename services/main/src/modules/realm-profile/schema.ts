import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { readId } from '../work/read-contract.ts';

export const REALM_PROFILE = 'https://rezics.com/definition/realm-public-profile-v1';
export const MAX_RULES = 12;
export const MAX_MODERATORS = 16;
/** Upper bounds per profile publication, independent of Realm membership size. */
export const REALM_PROFILE_COST = { rules: MAX_RULES, moderators: MAX_MODERATORS,
  payloadCharacters: 16_000, graphCalls: 20, mediaPointReads: 2,
  governancePointReads: MAX_RULES, homeGraphCalls: 12,
  homeGovernancePointReads: MAX_RULES } as const;
export const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const uuid = /^[0-9a-f-]{36}$/;

export const localizedName = t.Object({ en: t.String({ minLength: 1, maxLength: 120 }),
  'zh-CN': t.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false });
export const localizedDescription = t.Object({ en: t.String({ minLength: 1, maxLength: 2000 }),
  'zh-CN': t.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false });
export const localizedRuleTitle = t.Object({ en: t.String({ minLength: 1, maxLength: 100 }),
  'zh-CN': t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
export const localizedRuleBody = t.Object({ en: t.String({ minLength: 1, maxLength: 1000 }),
  'zh-CN': t.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false });
export const communityRule = t.Object({ id: t.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 }),
  title: localizedRuleTitle, body: localizedRuleBody,
  governanceRule: t.Nullable(t.Object({ ref: t.String({ minLength: 1, maxLength: 512 }),
    revision: t.String({ pattern: '^[1-9][0-9]{0,18}$' }) }, { additionalProperties: false })) },
{ additionalProperties: false });
export const memberCount = t.Union([
  // Exact requests select disclosure policy; Access supplies the value at read time.
  t.Object({ kind: t.Literal('exact'), value: t.Null() }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('unknown'), value: t.Null() }, { additionalProperties: false }),
  t.Object({ kind: t.Literal('estimated'), value: t.Integer({ minimum: 0, maximum: 1_000_000_000 }) },
    { additionalProperties: false }),
]);
export const publicProfile = t.Object({ name: localizedName, description: localizedDescription,
  iconSelection: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
  bannerSelection: t.Nullable(t.String({ pattern: '^[0-9a-f-]{36}$' })),
  replyPolicy: t.Optional(t.Union([t.Literal('moderated'), t.Literal('members-direct')])),
  rules: t.Array(communityRule, { maxItems: MAX_RULES }), count: memberCount,
  moderators: t.Array(readId, { maxItems: MAX_MODERATORS }) }, { additionalProperties: false });

export type PublicProfile = Static<typeof publicProfile>;

export class RealmProfileInvalid extends Error {}
export class RealmProfileMissing extends Error {}
export class RealmProfileStale extends Error {
  constructor(message: string, readonly currentHead: string | null = null) { super(message); }
}
export class RealmProfileUnavailable extends Error {}

export function checkedProfile(profile: PublicProfile): PublicProfile {
  if (!Value.Check(publicProfile, profile)) throw new RealmProfileInvalid('Realm public profile is invalid');
  const fields = [profile.name.en, profile.name['zh-CN'], profile.description.en,
    profile.description['zh-CN'], ...profile.rules.flatMap(rule => [rule.title.en,
      rule.title['zh-CN'], rule.body.en, rule.body['zh-CN'], rule.governanceRule?.ref ?? 'ok'])];
  if (fields.some(value => !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    || new Set(profile.rules.map(rule => rule.id)).size !== profile.rules.length
    || new Set(profile.moderators).size !== profile.moderators.length
    || JSON.stringify(profile).length > 16000) {
    throw new RealmProfileInvalid('Realm public profile is invalid');
  }
  return profile;
}
