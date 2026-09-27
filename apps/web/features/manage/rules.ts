import type { UiLocale } from '../../i18n/define.ts';
import type { RealmRule, SettingsView } from './types.ts';

// A Realm's rules have one approved meaning and several localized forms.
//
// - The meaning moderators cite is the exact published revision of the Realm's
//   rules document (`ruleBasis`: ref, revision, digest). Reading the rules in
//   another interface language never changes which revision applies.
// - Each rule is written in English and Chinese. A language the rule is not
//   written in falls back explicitly, and the page says which language it shows.
// - Any edit, including a translation fix, publishes a new revision; earlier
//   decisions keep citing the revision they were made under.
// - Publishing is compare-and-set on the revision the editor started from, so a
//   concurrent publication is a conflict that keeps the draft, never an overwrite.

/** Main's stored languages for rule text (`localizedRuleTitle` in `realm-profile/schema.ts`). */
export type RuleLanguage = 'en' | 'zh-CN';
export const ruleLanguages: readonly RuleLanguage[] = ['en', 'zh-CN'];
/** The BCP 47 tag each stored language is written in, for `lang` attributes. */
export const ruleLanguageTag: Record<RuleLanguage, string> = { en: 'en', 'zh-CN': 'zh-Hans' };

export const RULE_LIMITS = { rules: 12, title: 100, body: 1000, id: 64 } as const;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The approved meaning a rule text belongs to. `revision` is null until rules are first published. */
export type RuleMeaning = SettingsView['ruleBasis'];

/**
 * The stored language an interface locale reads. Traditional Chinese readers
 * get the Simplified text, the closest written form; every other locale reads
 * English. Either way the page names the language it shows.
 */
export function ruleLanguageFor(locale: UiLocale): { language: RuleLanguage; exact: boolean } {
  if (locale === 'en') return { language: 'en', exact: true };
  if (locale === 'zh-Hans') return { language: 'zh-CN', exact: true };
  if (locale === 'zh-Hant') return { language: 'zh-CN', exact: false };
  return { language: 'en', exact: false };
}

export interface ShownText {
  text: string;
  /** BCP 47 tag of the text actually shown. */
  lang: string;
  /** The stored language shown instead of the reader's, or null when it is the reader's own. */
  fallback: RuleLanguage | null;
}

function shown(values: Record<RuleLanguage, string>, locale: UiLocale): ShownText {
  const preferred = ruleLanguageFor(locale);
  const order = [preferred.language, ...ruleLanguages.filter(language => language !== preferred.language)];
  const language = order.find(item => values[item].trim()) ?? preferred.language;
  return { text: values[language], lang: ruleLanguageTag[language],
    fallback: preferred.exact && language === preferred.language ? null : language };
}

/** A rule as a reader of `locale` sees it. The meaning it belongs to is the same in every locale. */
export function shownRule(rule: Pick<RealmRule, 'title' | 'body'>, locale: UiLocale) {
  return { title: shown(rule.title, locale), body: shown(rule.body, locale) };
}

export type LanguageStatus =
  /** Same text as the published rule. */
  | 'unchanged'
  /** Changed from the published rule. */
  | 'edited'
  /** Not written yet; Main requires both languages before publishing. */
  | 'missing'
  /** Unchanged while another language changed: check it still says the same thing. */
  | 'check'
  /** A rule that is not published yet. */
  | 'new';

export function languageStatus(draft: Pick<RealmRule, 'title' | 'body'>, published: RealmRule | undefined):
  Record<RuleLanguage, LanguageStatus> {
  const missing = (language: RuleLanguage) => !draft.title[language].trim() || !draft.body[language].trim();
  const edited = (language: RuleLanguage) => published !== undefined
    && (draft.title[language] !== published.title[language] || draft.body[language] !== published.body[language]);
  const anyEdited = ruleLanguages.some(edited);
  return Object.fromEntries(ruleLanguages.map(language => [language,
    missing(language) ? 'missing' : !published ? 'new' : edited(language) ? 'edited'
      : anyEdited ? 'check' : 'unchanged'])) as Record<RuleLanguage, LanguageStatus>;
}

export type RuleChange =
  | { kind: 'added'; rule: RealmRule }
  | { kind: 'removed'; rule: RealmRule }
  | { kind: 'edited'; rule: RealmRule; languages: RuleLanguage[]; check: RuleLanguage[] }
  | { kind: 'moved'; rule: RealmRule; from: number; to: number };

/** What publishing the draft would change, rule by rule, in the draft's order. */
export function compareRules(published: readonly RealmRule[], draft: readonly RealmRule[]): RuleChange[] {
  const before = new Map(published.map((rule, index) => [rule.id, { rule, index }]));
  const draftIds = new Set(draft.map(rule => rule.id));
  const changes: RuleChange[] = [];
  const kept = published.filter(rule => draftIds.has(rule.id)).map(rule => rule.id);
  const keptInDraft = draft.filter(rule => before.has(rule.id)).map(rule => rule.id);
  for (const rule of draft) {
    const prior = before.get(rule.id);
    if (!prior) { changes.push({ kind: 'added', rule }); continue; }
    const status = languageStatus(rule, prior.rule);
    const languages = ruleLanguages.filter(language => status[language] === 'edited'
      || status[language] === 'missing' && (prior.rule.title[language] !== rule.title[language]
        || prior.rule.body[language] !== rule.body[language]));
    if (languages.length) {
      changes.push({ kind: 'edited', rule, languages,
        check: ruleLanguages.filter(language => status[language] === 'check') });
    }
    const from = kept.indexOf(rule.id);
    const to = keptInDraft.indexOf(rule.id);
    if (from !== to) changes.push({ kind: 'moved', rule, from: prior.index, to: draft.indexOf(rule) });
  }
  for (const rule of published) if (!draftIds.has(rule.id)) changes.push({ kind: 'removed', rule });
  return changes;
}

export type RuleProblem =
  | { index: number; field: 'title' | 'body'; language: RuleLanguage; problem: 'missing' | 'too-long' }
  | { index: number; field: 'id'; problem: 'duplicate' | 'invalid' };

/** Why Main would refuse the draft (`realmSettings` and `saveRealmSettings`), checked before sending. */
export function ruleProblems(draft: readonly RealmRule[]): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const seen = new Set<string>();
  draft.forEach((rule, index) => {
    if (!idPattern.test(rule.id) || rule.id.length > RULE_LIMITS.id) problems.push({ index, field: 'id', problem: 'invalid' });
    else if (seen.has(rule.id)) problems.push({ index, field: 'id', problem: 'duplicate' });
    seen.add(rule.id);
    for (const field of ['title', 'body'] as const) {
      for (const language of ruleLanguages) {
        const value = rule[field][language];
        if (!value.trim()) problems.push({ index, field, language, problem: 'missing' });
        else if (value.length > RULE_LIMITS[field]) problems.push({ index, field, language, problem: 'too-long' });
      }
    }
  });
  return problems;
}

/** A stable rule identity from its English title ("No spoilers!" → "no-spoilers"), unique in the draft. */
export function ruleIdFrom(title: string, taken: ReadonlySet<string>): string {
  const base = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, RULE_LIMITS.id - 4).replace(/-+$/, '') || 'rule';
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

export const emptyRule = (id: string): RealmRule => ({ id, title: { en: '', 'zh-CN': '' },
  body: { en: '', 'zh-CN': '' }, governanceRule: null });

/** The revision publishing would create, when the current one is known. */
export const nextRevision = (meaning: RuleMeaning) => meaning.revision === null ? '1'
  : (BigInt(meaning.revision) + 1n).toString();
