import type { UiLocale } from '../../i18n/define.ts';
import type { RealmRule, SettingsView } from './types.ts';

// Moderators cite one immutable rule revision. Each field keeps its authored
// original and optional translations; an interface locale never supplies a tag.
export type RuleLanguage = string;
type RuleText = RealmRule['title'];

/** Languages actually recorded in these independent title/body fields. */
export function ruleLanguages(...rules: Pick<RealmRule, 'title' | 'body'>[]): RuleLanguage[] {
  return [...new Set(rules.flatMap(rule => [rule.title.original, ...Object.keys(rule.title.labels),
    rule.body.original, ...Object.keys(rule.body.labels)]))];
}

export const RULE_LIMITS = { rules: 12, title: 100, body: 1000, id: 64 } as const;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The approved meaning a rule text belongs to. `revision` is null until rules are first published. */
export type RuleMeaning = SettingsView['ruleBasis'];

export interface ShownText {
  text: string;
  /** Language recorded on the selected field, including und when not recorded. */
  lang: string;
  fallback: RuleLanguage | null;
}

function shown(field: RuleText, locale: UiLocale): ShownText {
  const language = field.labels[locale]?.trim() ? locale
    : field.labels[field.original]?.trim() ? field.original
      : Object.keys(field.labels).find(tag => field.labels[tag]?.trim()) ?? field.original;
  return { text: field.labels[language] ?? '', lang: language,
    fallback: language === locale ? null : language };
}

/** Select each field independently without inventing a translation or crossing scripts. */
export function shownRule(rule: Pick<RealmRule, 'title' | 'body'>, locale: UiLocale) {
  return { title: shown(rule.title, locale), body: shown(rule.body, locale) };
}

export type LanguageStatus =
  /** Same text as the published rule. */
  | 'unchanged'
  /** Changed from the published rule. */
  | 'edited'
  /** An authored field is empty or its original label is missing. */
  | 'missing'
  /** Unchanged while another language changed: check it still says the same thing. */
  | 'check'
  /** A rule that is not published yet. */
  | 'new';

export function languageStatus(draft: Pick<RealmRule, 'title' | 'body'>, published: RealmRule | undefined):
  Record<RuleLanguage, LanguageStatus> {
  const languages = ruleLanguages(draft, ...published ? [published] : []);
  const missing = (language: RuleLanguage) => [draft.title, draft.body].some(field =>
    (language in field.labels || language === field.original) && !field.labels[language]?.trim());
  const edited = (language: RuleLanguage) => published !== undefined
    && (draft.title.labels[language] !== published.title.labels[language]
      || draft.body.labels[language] !== published.body.labels[language]
      || (draft.title.original !== published.title.original
        && [draft.title.original, published.title.original].includes(language))
      || (draft.body.original !== published.body.original
        && [draft.body.original, published.body.original].includes(language)));
  const anyEdited = languages.some(edited);
  return Object.fromEntries(languages.map(language => [language,
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
    const languages = Object.keys(status).filter(language => status[language] === 'edited'
      || status[language] === 'missing' && (prior.rule.title.labels[language] !== rule.title.labels[language]
        || prior.rule.body.labels[language] !== rule.body.labels[language]));
    if (languages.length) {
      changes.push({ kind: 'edited', rule, languages,
        check: Object.keys(status).filter(language => status[language] === 'check') });
    }
    const from = kept.indexOf(rule.id);
    const to = keptInDraft.indexOf(rule.id);
    if (from !== to) changes.push({ kind: 'moved', rule, from: prior.index, to: draft.indexOf(rule) });
  }
  for (const rule of published) if (!draftIds.has(rule.id)) changes.push({ kind: 'removed', rule });
  return changes;
}

export type RuleProblem =
  | { index: number; field: 'title' | 'body'; language: RuleLanguage; problem: 'missing' | 'too-long' | 'invalid' }
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
      const text = rule[field];
      const entries = Object.entries(text.labels);
      const canonical = (language: string) => {
        try { return /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(language)
          && Intl.getCanonicalLocales(language)[0] === language; } catch { return false; }
      };
      if (!canonical(text.original) || entries.length > 20) {
        problems.push({ index, field, language: text.original, problem: 'invalid' });
      }
      if (!(text.original in text.labels)) problems.push({ index, field, language: text.original, problem: 'missing' });
      for (const [language, value] of entries) {
        if (!canonical(language) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
          problems.push({ index, field, language, problem: 'invalid' });
        } else if (!value.trim()) problems.push({ index, field, language, problem: 'missing' });
        else if (value.length > RULE_LIMITS[field]) problems.push({ index, field, language, problem: 'too-long' });
      }
    }
  });
  return problems;
}

/** A stable rule identity from its original title ("No spoilers!" → "no-spoilers"), unique in the draft. */
export function ruleIdFrom(title: string, taken: ReadonlySet<string>): string {
  const base = title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, RULE_LIMITS.id - 4).replace(/-+$/, '') || 'rule';
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) if (!taken.has(`${base}-${suffix}`)) return `${base}-${suffix}`;
}

/** A simple authoring surface records unknown language until the author declares one. */
export const ruleFromText = (id: string, title: string, body: string, language = 'und'): RealmRule => ({ id,
  title: { original: language, labels: { [language]: title } },
  body: { original: language, labels: { [language]: body } }, governanceRule: null });
export const emptyRule = (id: string): RealmRule => ruleFromText(id, '', '');

/** Previously saved local drafts use the same v1 compatibility rule as Main reads. */
export function restoredRule(rule: RealmRule): RealmRule {
  const restoredText = (field: RuleText): RuleText => {
    if (field && typeof field.original === 'string' && field.labels && typeof field.labels === 'object'
      && Object.values(field.labels).every(value => typeof value === 'string')) return field;
    const legacy = field as unknown as { en?: unknown; 'zh-CN'?: unknown };
    if (typeof legacy?.en !== 'string' || typeof legacy['zh-CN'] !== 'string') throw new Error('Invalid saved rule');
    return legacy.en === legacy['zh-CN'] ? { original: 'und', labels: { und: legacy.en } }
      : { original: 'en', labels: { en: legacy.en, 'zh-Hans': legacy['zh-CN'] } };
  };
  return { ...rule, title: restoredText(rule.title), body: restoredText(rule.body) };
}

/** The revision publishing would create, when the current one is known. */
export const nextRevision = (meaning: RuleMeaning) => meaning.revision === null ? '1'
  : (BigInt(meaning.revision) + 1n).toString();
