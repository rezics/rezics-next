'use client';

import type { UiLocale } from '../../i18n/define.ts';
import { ConditionBar as SharedConditionBar, type ValueSearch }
  from '../query/condition-bar.tsx';
import type { ConceptMessages } from './messages.ts';
import { type ConceptState, conceptHref, DEFAULT_MAX_VALUES } from './state.ts';

type Name = { value: string; language: string; direction: 'ltr' | 'rtl' };
export interface BarValue { id: string; name: Name | null }
export type ConceptSearch = ValueSearch;

/** A Concept page edits the same Query Conditions while keeping its page Concept fixed. */
export function ConditionBar({ state, page, values, suggestions, maxValues = DEFAULT_MAX_VALUES, search,
  locale }: {
  state: ConceptState; page: BarValue; values: readonly BarValue[]; suggestions: readonly BarValue[];
  maxValues?: number; search?: ConceptSearch; locale: UiLocale; messages: ConceptMessages;
}) {
  const named = [page, ...values, ...suggestions].flatMap(value => value.name ? [{ id: value.id,
    name: value.name.value, language: value.name.language }] : []);
  const offered = suggestions.flatMap(value => value.name ? [{ id: value.id,
    name: value.name.value, language: value.name.language }] : []);
  return <SharedConditionBar selection={{ include: [state.concept, ...state.include], exclude: state.exclude,
    match: state.match }} fixed={state.concept} values={named} suggestions={offered}
    maxValues={maxValues} search={search}
    realm={state.scope.kind === 'realm' ? state.scope.realm : null} locale={locale}
    href={next => conceptHref({ ...state, include: next.include.filter(id => id !== state.concept),
      exclude: next.exclude, match: next.match })} />;
}
