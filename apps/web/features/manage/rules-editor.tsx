'use client';

import { Badge } from '@rezics/ui/badge';
import { Button } from '@rezics/ui/button';
import { Field, FieldError, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { Textarea } from '@rezics/ui/textarea';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { LanguageSelect } from '../content-language/language-select.tsx';
import { textAttributes, writingLanguage } from '../content-language/writing-language.ts';
import type { ManageMessages } from './messages.ts';
import { ruleLanguageName } from './rule-list.tsx';
import { addRuleTranslation, emptyRule, type LanguageStatus, languageStatus, removeRuleTranslation, RULE_LIMITS,
  ruleIdFrom, type RuleLanguage, ruleLanguages, type RuleProblem, setRuleOriginal } from './rules.ts';
import type { RealmRule } from './types.ts';

/** A rule being edited. `key` is stable while an unpublished rule's identity follows its original title. */
export interface RuleDraft { key: string; rule: RealmRule; published: boolean }

export const draftsOf = (rules: readonly RealmRule[]): RuleDraft[] =>
  rules.map(rule => ({ key: rule.id, rule, published: true }));

const statusBadge: Record<LanguageStatus, 'statusEdited' | 'statusMissing' | 'statusCheck' | 'statusNew' | null> = {
  unchanged: null, edited: 'statusEdited', missing: 'statusMissing', check: 'statusCheck', new: 'statusNew' };

/**
 * The recorded languages of every rule side by side, each with its status against the
 * published revision: edited, missing, new, or unchanged while the other
 * language changed ("check wording").
 */
export function RulesEditor({ drafts, published, problems, onChange, locale, messages, reading = [] }: {
  drafts: readonly RuleDraft[]; published: readonly RealmRule[]; problems: readonly RuleProblem[] | null;
  onChange: (drafts: RuleDraft[]) => void; locale: UiLocale; messages: ManageMessages;
  /** The author's reading languages: where a new rule starts and what translations are suggested. */
  reading?: readonly string[];
}) {
  const t = materializeData(messages, { locale });
  const before = new Map(published.map(rule => [rule.id, rule]));
  const update = (index: number, rule: RealmRule) => onChange(drafts.map((draft, at) => {
    if (at !== index) return draft;
    if (draft.published) return { ...draft, rule };
    const taken = new Set(drafts.filter((_, other) => other !== index).map(item => item.rule.id));
    return { ...draft, rule: { ...rule, id: ruleIdFrom(rule.title.labels[rule.title.original] ?? '', taken) } };
  }));
  const move = (index: number, delta: -1 | 1) => {
    const next = [...drafts];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    onChange(next);
  };
  const problemText = (problem: RuleProblem) => {
    if (problem.field === 'id') return t.problemId;
    const field = problem.field === 'title' ? t.fieldTitle : t.fieldBody;
    const language = ruleLanguageName(problem.language, t, locale);
    if (problem.problem === 'invalid') return t.settingsInvalid;
    return problem.problem === 'missing' ? t.problemMissing({ field, language }) : t.problemTooLong({ field, language });
  };
  return <div className="grid gap-4">
    <ol className="grid gap-4">
      {drafts.map((draft, index) => {
        const status = languageStatus(draft.rule, before.get(draft.rule.id));
        const own = problems?.filter(problem => problem.index === index) ?? [];
        const languages = ruleLanguages(draft.rule);
        const changed = languages.filter(language => status[language] === 'edited');
        const check = languages.filter(language => status[language] === 'check');
        const number = String(index + 1);
        return <li key={draft.key} className="grid gap-4 rounded-2xl border border-border/60 bg-card p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{t.ruleNumber({ number })}</h3>
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => move(index, -1)}
                aria-label={`${t.moveUp}: ${t.ruleNumber({ number })}`}><ArrowUpIcon aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon-sm" disabled={index === drafts.length - 1}
                onClick={() => move(index, 1)} aria-label={`${t.moveDown}: ${t.ruleNumber({ number })}`}>
                <ArrowDownIcon aria-hidden="true" /></Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(drafts.filter((_, at) => at !== index))}
                aria-label={`${t.removeRule}: ${t.ruleNumber({ number })}`}><Trash2Icon aria-hidden="true" /></Button>
            </div>
          </div>
          {draft.rule.title.original === draft.rule.body.original ? <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t.ruleWrittenIn}</span>
            <LanguageSelect value={draft.rule.title.original} locale={locale} reading={reading}
              label={`${t.ruleWrittenIn} — ${t.ruleNumber({ number })}`}
              onChange={language => update(index, setRuleOriginal(draft.rule, language))} />
          </div> : null}
          <div className="grid gap-4 lg:grid-cols-2">
            {languages.map((language: RuleLanguage) => {
              const name = ruleLanguageName(language, t, locale);
              const badge = statusBadge[status[language]];
              const error = (field: 'title' | 'body') => own.find(problem => problem.field === field
                && problem.language === language);
              const titleError = error('title');
              const bodyError = error('body');
              return <fieldset key={language} className="grid content-start gap-3 rounded-xl bg-muted/30 p-3.5">
                <legend className="sr-only">{badge ? `${name}, ${t[badge]}` : name}</legend>
                <div aria-hidden="true" className="flex items-center justify-between gap-2">
                  <span className="font-medium text-sm">{name}</span>
                  {language === draft.rule.title.original ? <Badge variant="outline">{t.ruleOriginal}</Badge> : null}
                  {badge ? <Badge variant={badge === 'statusMissing' ? 'destructive' : badge === 'statusCheck' ? 'warning'
                    : 'secondary'}>{t[badge]}</Badge> : null}
                </div>
                {language in draft.rule.title.labels || language === draft.rule.title.original ? <Field invalid={titleError !== undefined}>
                  <FieldLabel>{t.ruleTitleLabel({ language: name })}</FieldLabel>
                  <Input {...textAttributes(language, draft.rule.title.labels[language])}
                    value={draft.rule.title.labels[language] ?? ''} maxLength={RULE_LIMITS.title + 20}
                    onChange={event => update(index, { ...draft.rule,
                      title: { ...draft.rule.title, labels: { ...draft.rule.title.labels, [language]: event.currentTarget.value } } })} />
                  {titleError ? <FieldError>{problemText(titleError)}</FieldError> : null}
                </Field> : null}
                {language in draft.rule.body.labels || language === draft.rule.body.original ? <Field invalid={bodyError !== undefined}>
                  <FieldLabel>{t.ruleBodyLabel({ language: name })}</FieldLabel>
                  <Textarea {...textAttributes(language, draft.rule.body.labels[language])} rows={3}
                    value={draft.rule.body.labels[language] ?? ''}
                    maxLength={RULE_LIMITS.body + 50} onChange={event => update(index, { ...draft.rule,
                      body: { ...draft.rule.body, labels: { ...draft.rule.body.labels, [language]: event.currentTarget.value } } })} />
                  {bodyError ? <FieldError>{problemText(bodyError)}</FieldError> : null}
                </Field> : null}
                {language !== draft.rule.title.original && language !== draft.rule.body.original
                  ? <Button type="button" variant="ghost" size="sm" className="justify-self-start"
                    onClick={() => update(index, removeRuleTranslation(draft.rule, language))}>
                    <Trash2Icon aria-hidden="true" />{t.removeTranslation({ language: name })}</Button> : null}
              </fieldset>;
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <LanguageSelect value={null} placeholder={t.addTranslation} locale={locale} reading={reading}
              original={draft.rule.title.original} label={`${t.addTranslation} — ${t.ruleNumber({ number })}`}
              disabled={languages.length >= 20}
              onChange={language => update(index, addRuleTranslation(draft.rule, language))} />
          </div>
          {changed.length === 1 && check.length ? <p className="text-sm text-warning-foreground">
            {t.checkHelp({ changed: ruleLanguageName(changed[0]!, t, locale), other: ruleLanguageName(check[0]!, t, locale) })}</p> : null}
          {own.some(problem => problem.field === 'id') ? <p className="text-destructive-foreground text-sm">{t.problemId}</p>
            : null}
        </li>;
      })}
    </ol>
    <div>
      <Button type="button" variant="outline" disabled={drafts.length >= RULE_LIMITS.rules} onClick={() => {
        const key = crypto.randomUUID();
        onChange([...drafts, { key, rule: emptyRule(ruleIdFrom('', new Set(drafts.map(item => item.rule.id))),
          writingLanguage({ reading })), published: false }]);
      }}><PlusIcon aria-hidden="true" />{t.addRule}</Button>
      {drafts.length >= RULE_LIMITS.rules ? <p className="mt-2 text-muted-foreground text-sm">
        {t.rulesLimit({ count: String(RULE_LIMITS.rules) })}</p> : null}
    </div>
  </div>;
}
