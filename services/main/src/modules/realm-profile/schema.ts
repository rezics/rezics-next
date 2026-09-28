import { t } from 'elysia';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { readId } from '../work/read-contract.ts';
import { canonicalLanguage, legacyLocalizedText, type LocalizedText } from '../display-language/select.ts';

export const REALM_PROFILE = 'https://rezics.com/definition/realm-public-profile-v2';
export const MAX_RULES = 12;
export const MAX_MODERATORS = 16;
/** Upper bounds per profile publication, independent of Realm membership size. */
export const REALM_PROFILE_COST = { rules: MAX_RULES, moderators: MAX_MODERATORS,
  payloadCharacters: 16_000, graphCalls: 20, mediaPointReads: 2,
  governancePointReads: MAX_RULES, homeGraphCalls: 13,
  homeGovernancePointReads: MAX_RULES } as const;
export const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const uuid = /^[0-9a-f-]{36}$/;

const language = t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 });
const localized = (length: number) => t.Object({ original: language,
  labels: t.Record(language, t.String({ minLength: 1, maxLength: length })) },
{ additionalProperties: false });
export const localizedName = localized(120);
export const localizedDescription = localized(2000);
export const localizedRuleTitle = localized(100);
export const localizedRuleBody = localized(1000);
export const communityRule = t.Object({ id: t.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 }),
  title: t.Object({ en: t.String({ minLength: 1, maxLength: 100 }),
    'zh-CN': t.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  body: t.Object({ en: t.String({ minLength: 1, maxLength: 1000 }),
    'zh-CN': t.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
  governanceRule: t.Nullable(t.Object({ ref: t.String({ minLength: 1, maxLength: 512 }),
    revision: t.String({ pattern: '^[1-9][0-9]{0,18}$' }) }, { additionalProperties: false })) },
{ additionalProperties: false });
const profileRule = t.Object({ ...communityRule.properties,
  title: localizedRuleTitle, body: localizedRuleBody }, { additionalProperties: false });
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
  rules: t.Array(profileRule, { maxItems: MAX_RULES }), count: memberCount,
  moderators: t.Array(readId, { maxItems: MAX_MODERATORS }) }, { additionalProperties: false });

export type PublicProfile = Static<typeof publicProfile>;

const legacy = (length: number) => t.Object({ en: t.String({ minLength: 1, maxLength: length }),
  'zh-CN': t.String({ minLength: 1, maxLength: length }) }, { additionalProperties: false });
const legacyPublicProfile = t.Object({ ...publicProfile.properties,
  name: legacy(120), description: legacy(2000),
  rules: t.Array(communityRule, { maxItems: MAX_RULES }) },
{ additionalProperties: false });

/** Old immutable revisions remain readable; the next publication writes v2. */
export function currentProfile(payload: unknown): PublicProfile {
  if (Value.Check(publicProfile, payload)) return checkedProfile(payload);
  if (!Value.Check(legacyPublicProfile, payload)) throw new RealmProfileInvalid('Realm public profile is invalid');
  return checkedProfile({ ...payload, name: legacyLocalizedText(payload.name),
    description: legacyLocalizedText(payload.description),
    rules: payload.rules.map(rule => ({ ...rule, title: legacyLocalizedText(rule.title),
      body: legacyLocalizedText(rule.body) })) });
}

export class RealmProfileInvalid extends Error {}
export class RealmProfileMissing extends Error {}
export class RealmProfileStale extends Error {
  constructor(message: string, readonly currentHead: string | null = null) { super(message); }
}
export class RealmProfileUnavailable extends Error {}

export function checkedProfile(profile: PublicProfile): PublicProfile {
  if (!Value.Check(publicProfile, profile)) throw new RealmProfileInvalid('Realm public profile is invalid');
  const localizedFields: LocalizedText[] = [profile.name, profile.description,
    ...profile.rules.flatMap(rule => [rule.title, rule.body])];
  const valid = localizedFields.every(field => {
    const entries = Object.entries(field.labels);
    return entries.length >= 1 && entries.length <= 20
      && canonicalLanguage(field.original) === field.original && field.original in field.labels
      && entries.every(([tag, value]) => canonicalLanguage(tag) === tag && !!value.trim());
  });
  const fields = [...localizedFields.flatMap(field => Object.values(field.labels)),
    ...profile.rules.map(rule => rule.governanceRule?.ref ?? 'ok')];
  if (!valid || fields.some(value => !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    || new Set(profile.rules.map(rule => rule.id)).size !== profile.rules.length
    || new Set(profile.moderators).size !== profile.moderators.length
    || JSON.stringify(profile).length > 16000) {
    throw new RealmProfileInvalid('Realm public profile is invalid');
  }
  return profile;
}
