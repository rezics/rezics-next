import { diagnoseText } from '../../../../packages/search-text/src/index.ts';
import { QueryTextRecovery } from './query-text-recovery';
import { useState } from 'react';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { RATING_POPULATION_FIELD } from './rating-population';
import type { SearchInputIssue } from './search-input/intake';
import { PageHeading } from '../shell/page-heading';

type MessageOptions = { locale: (typeof locales)[number] };

function messageOptions(locale: string): MessageOptions {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

type LegacyProps = {
  parameter: string;
  value: string;
  onApply: (value: string) => void;
  onRemove: () => void;
  locale?: string;
};

type IntakeProps = {
  issues: SearchInputIssue[];
  onApply: (issue: SearchInputIssue, value: string) => void;
  onRemove: (issue: SearchInputIssue) => void;
  locale?: string;
};

type OverBudgetProps = { overBudget: true; onRestart: () => void; locale?: string };

function fieldName(issue: SearchInputIssue, options: MessageOptions) {
  const { key } = issue;
  if (key === 'q') return m.search_input_field_query({}, options);
  if (key === 'type') return m.search_input_field_type({}, options);
  if (key === 'cursor') return m.search_input_field_cursor({}, options);
  if (key === 'sort') return m.search_input_field_order({}, options);
  if (key === 'kinds') return m.search_input_field_kinds({}, options);
  if (key === 'language') return m.search_input_field_languages({}, options);
  if (key === 'condition') return m.search_input_field_condition({}, options);
  if (key === 'filter') return m.search_input_field_filter({}, options);
  if (key === RATING_POPULATION_FIELD) return m.search_input_field_population({}, options);
  if (key.startsWith('r.')) return m.search_input_field_range({ property: key.slice(2) }, options);
  if (key.startsWith('f.')) return m.search_input_field_facet({ property: key.slice(2) }, options);
  return key;
}

function reasonText(issue: SearchInputIssue, field: string, options: MessageOptions) {
  switch (issue.reason) {
    case 'invalid-shape':
      return m.search_input_reason_shape({ field }, options);
    case 'repeated-scalar':
      return m.search_input_reason_repeated({ field }, options);
    case 'too-many':
      return m.search_input_reason_too_many({ field, maximum: issue.maximum ?? 0 }, options);
    case 'invalid-query':
      return m.search_input_reason_query({ field }, options);
    case 'invalid-type':
      return m.search_input_reason_type({ field }, options);
    case 'invalid-language':
      return m.search_input_reason_language({ field }, options);
    case 'invalid-order':
      return m.search_input_reason_order({ field }, options);
    case 'invalid-cursor':
      return m.search_input_reason_cursor({ field }, options);
    case 'invalid-condition':
    case 'invalid-filter':
    case 'invalid-range':
      return m.search_input_reason_structured({ field }, options);
    case 'invalid-facet':
      return m.search_input_reason_shape({ field }, options);
    case 'invalid-population':
      return m.search_input_reason_population({ field }, options);
  }
}

function removalLabel(issue: SearchInputIssue, field: string, options: MessageOptions) {
  if (issue.key === 'cursor') return m.search_input_restart_first_window({}, options);
  if (issue.removal === 'occurrence')
    return m.search_input_remove_occurrence({ field, occurrence: (issue.occurrence ?? 0) + 1 }, options);
  if (issue.removal === 'structured') return m.search_input_remove_structured({ field }, options);
  return m.search_input_remove_field({ field }, options);
}

function issueId(issue: SearchInputIssue, index: number): string {
  return `${issue.key}:${issue.occurrence ?? 'whole'}:${issue.reason}:${index}`;
}

export function SearchInputRecovery(props: LegacyProps | IntakeProps | OverBudgetProps) {
  const isLegacy = 'parameter' in props;
  const overBudget = 'overBudget' in props && props.overBudget;
  const locale = props.locale;
  const options = locale === undefined ? { locale: 'en' as const } : messageOptions(locale);
  const issues: SearchInputIssue[] = 'issues' in props
    ? props.issues
    : 'parameter' in props
      ? [
        {
          key: props.parameter,
          value: props.value,
          reason: props.parameter === 'q' ? 'invalid-query' : 'invalid-shape',
          removal: 'field',
        },
      ]
      : [];
  const [drafts, setDrafts] = useState(() => Object.fromEntries(issues.map((issue, index) => [issueId(issue, index), issue.value])));
  const apply = (issue: SearchInputIssue, value: string) => {
    if ('parameter' in props) props.onApply(value);
    else if ('issues' in props) props.onApply(issue, value);
  };
  const remove = (issue: SearchInputIssue) => {
    if ('parameter' in props) props.onRemove();
    else if ('issues' in props) props.onRemove(issue);
  };

  return (
    <section className="mx-auto max-w-5xl space-y-6" data-search-input-recovery>
      <PageHeading>{m.search_heading({}, options)}</PageHeading>
      <Empty className="border" role="alert">
        <EmptyHeader>
          <EmptyTitle className="text-base font-normal">{m.search_input_recovery_title({}, options)}</EmptyTitle>
        </EmptyHeader>
        {overBudget ? (
          <>
            <p>{m.search_input_recovery_over_budget({}, options)}</p>
            <button
              className="rounded-md border px-4 py-2"
              data-search-input-restart
              type="button"
              onClick={() => 'onRestart' in props && props.onRestart()}
            >
              {m.search_input_restart_request({}, options)}
            </button>
          </>
        ) : (
          <>
            {!isLegacy && <p>{m.search_input_recovery_intro({}, options)}</p>}
            <div className="w-full space-y-5">
              {issues.map((issue, index) => {
                const id = issueId(issue, index);
                const field = fieldName(issue, options);
                const occurrence = issue.occurrence === undefined
                  ? undefined
                  : m.search_input_occurrence({ occurrence: issue.occurrence + 1 }, options);
                const first = index === 0 ? { 'data-search-input-first': '' } : {};
                return (
                  <article
                    key={id}
                    className="space-y-3 rounded-lg border p-4"
                    data-search-input-key={issue.key}
                    data-search-input-occurrence={issue.occurrence}
                    {...first}
                  >
                    <h2 className="font-medium">
                      {field}
                      {occurrence ? ` · ${occurrence}` : ''}
                    </h2>
                    <p className="text-sm text-muted-foreground">{reasonText(issue, field, options)}</p>
                    <details className="text-sm">
                      <summary>{m.search_input_submitted_value({}, options)}</summary>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">{issue.value}</pre>
                    </details>
                    {issue.key === 'q' ? (
                      <>
                        <QueryTextRecovery
                          key={id}
                          value={drafts[id] ?? issue.value}
                          diagnostic={diagnoseText(drafts[id] ?? issue.value)}
                          locale={locale}
                          onApply={(value) => apply(issue, value)}
                        />
                        <button
                          className="rounded-md border px-4 py-2"
                          type="button"
                          onClick={() => remove(issue)}
                        >
                          {removalLabel(issue, field, options)}
                        </button>
                      </>
                    ) : issue.key === 'cursor' ? (
                      <button
                        className="rounded-md border px-4 py-2"
                        data-search-input-control
                        type="button"
                        onClick={() => remove(issue)}
                      >
                        {removalLabel(issue, field, options)}
                      </button>
                    ) : (
                      <form
                        className="w-full space-y-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          apply(issue, drafts[id] ?? issue.value);
                        }}
                      >
                        <label className="block space-y-2 text-sm font-medium" htmlFor={`search-input-${index}`}>
                          {m.search_input_editor_label({ field }, options)}
                          <textarea
                            autoCapitalize="off"
                            autoComplete="off"
                            autoCorrect="off"
                            className="min-h-32 w-full rounded-md border bg-background p-3 font-mono text-sm text-foreground"
                            data-search-input-control
                            id={`search-input-${index}`}
                            spellCheck={false}
                            value={drafts[id] ?? issue.value}
                            onChange={(event) =>
                              setDrafts((current) => ({ ...current, [id]: event.currentTarget.value }))
                            }
                          />
                        </label>
                        <div className="flex flex-wrap gap-3">
                          <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground" type="submit">
                            {m.search_input_recovery_apply({}, options)}
                          </button>
                          <button className="rounded-md border px-4 py-2" type="button" onClick={() => remove(issue)}>
                            {removalLabel(issue, field, options)}
                          </button>
                        </div>
                      </form>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </Empty>
    </section>
  );
}
