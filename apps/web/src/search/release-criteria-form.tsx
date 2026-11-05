import { useEffect, useRef, useState, type FormEvent } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { quantityUnitLabel } from '../subject/quantity-presentation';
import { ConditionLanguages } from './language-preferences';
import { calendarPrecision } from './condition-calendar';
import {
  HEADER_SUGGESTION_LIMIT,
  loadGlobalHeaderSuggestions,
  readHeaderSuggestions,
} from './header-search/suggestions';
import type { SuggestionResult } from './suggestions';
import { localizedLabel } from './results';
import {
  parseReleaseSearchDraft,
  type ParsedReleaseSearch,
  type ReleaseSearchForm,
  type ReleaseSearchSelections,
  type ReleaseSearchSubjectSelection,
  type ReleaseSearchType,
} from './release-search';

const fieldClass = 'h-10 rounded-md border bg-background px-3 font-normal';
const subjectFields = ['platform', 'developer', 'publisher'] as const;
type SubjectField = (typeof subjectFields)[number];
type ReleaseCriteriaDraft = { form: ReleaseSearchForm; languageTags: string[] };
type CriteriaField = keyof ReleaseSearchForm;
const semanticFields = [
  'platform',
  'releaseLanguage',
  'gte',
  'lte',
  'ageGte',
  'ageLte',
  'ageUnit',
  'developer',
  'publisher',
] as const;
type SemanticField = (typeof semanticFields)[number];

function languageTags(form: ReleaseSearchForm, invalid: boolean): string[] {
  if (form.language === '') return invalid ? [''] : [];
  return form.language.split(',').map((tag) => tag.trim());
}

function draftFor(parsed: ParsedReleaseSearch): ReleaseCriteriaDraft {
  return { form: parsed.form, languageTags: languageTags(parsed.form, parsed.invalid.includes('language')) };
}

function draftInput(draft: ReleaseCriteriaDraft): Record<string, unknown> {
  return {
    ...draft.form,
    language: draft.languageTags.length ? draft.languageTags : undefined,
  };
}

function releaseLanguageMeaning(subtype: string, platform: string, types: readonly ReleaseSearchType[]): string {
  const controls = types.find((type) => type.id === subtype)?.controls;
  if (platform) {
    if (controls?.platform?.languageQualifier)
      return `qualifier:${controls.platform.property}:${controls.platform.languageQualifier}`;
    return 'unsupported-platform-language';
  }
  return controls?.language ? `statement:${controls.language.property}` : 'unsupported-language';
}

function criteriaMeaning(field: SemanticField, subtype: string, platform: string, types: readonly ReleaseSearchType[]) {
  const controls = types.find((type) => type.id === subtype)?.controls;
  if (field === 'platform') return controls?.platform?.property ?? 'unsupported-platform';
  if (field === 'releaseLanguage') return releaseLanguageMeaning(subtype, platform, types);
  if (field === 'gte' || field === 'lte') return controls?.date?.property ?? 'unsupported-date';
  if (field === 'ageGte' || field === 'ageLte' || field === 'ageUnit')
    return controls?.ageRating?.property ?? 'unsupported-age-rating';
  return controls?.producers.find((producer) => producer.role === field)?.property ?? `unsupported-${field}`;
}

function unitLabel(unit: string, locale: string): string {
  const noRelated = Object.create(null) as Parameters<typeof quantityUnitLabel>[1];
  return quantityUnitLabel(unit, noRelated, locale) ?? unit;
}

function issueText(
  field: keyof ReleaseSearchForm,
  draft: ReleaseCriteriaDraft,
  controls: ReleaseSearchType['controls'] | null,
  locale: string,
): string {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const labels: Record<keyof ReleaseSearchForm, string> = {
    subtype: m.release_search_subtype({}, options),
    q: m.release_search_text({}, options),
    platform: m.release_search_platform({}, options),
    releaseLanguage: m.release_search_languages({}, options),
    gte: m.release_search_date_lower({}, options),
    lte: m.release_search_date_upper({}, options),
    ageGte: m.release_search_age_lower({}, options),
    ageLte: m.release_search_age_upper({}, options),
    ageUnit: m.release_search_age_unit({}, options),
    developer: m.release_search_developer({}, options),
    publisher: m.release_search_publisher({}, options),
    language: m.condition_languages_label({}, options),
    sort: m.release_search_sort({}, options),
    threshold: m.release_search_spoilers({}, options),
    condition: m.release_search_condition({}, options),
  };
  const unsupported =
    (field === 'subtype' && !controls) ||
    (field === 'platform' && Boolean(draft.form.platform) && !controls?.platform) ||
    (field === 'releaseLanguage' &&
      Boolean(draft.form.releaseLanguage) &&
      (draft.form.platform ? !controls?.platform?.languageQualifier : !controls?.language)) ||
    ((field === 'gte' || field === 'lte') && Boolean(draft.form[field]) && !controls?.date) ||
    ((field === 'ageGte' || field === 'ageLte' || field === 'ageUnit') &&
      Boolean(draft.form[field]) &&
      (!controls?.ageRating || (field === 'ageUnit' && !controls.ageRating.units.includes(draft.form.ageUnit)))) ||
    ((field === 'developer' || field === 'publisher') &&
      Boolean(draft.form[field]) &&
      !controls?.producers.some((producer) => producer.role === field));
  return unsupported
    ? m.search_reader_condition_unsupported({ field: labels[field] }, options)
    : m.search_reader_condition_invalid({ field: labels[field] }, options);
}

function ReleaseSearchSubjectPicker({
  name,
  label,
  help,
  locale,
  invalid,
  errorId,
  selection,
  onSelection,
  onPendingChange,
}: {
  name: SubjectField;
  label: string;
  help: string;
  locale: string;
  invalid: boolean;
  errorId?: string;
  selection?: ReleaseSearchSubjectSelection | undefined;
  onSelection(value?: ReleaseSearchSubjectSelection): void;
  onPendingChange(pending: boolean): void;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const inputId = `release-search-${name}`;
  const listId = `${inputId}-suggestions`;
  const helpId = `${inputId}-help`;
  const inputRef = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<SuggestionResult>();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'unavailable'>('idle');
  const [activeIndex, setActiveIndex] = useState(-1);
  const active = suggestions?.subjects[activeIndex];
  const cancel = () => {
    request.current?.abort();
    request.current = undefined;
    setSuggestions(undefined);
    setStatus('idle');
    setActiveIndex(-1);
  };

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setSuggestions(undefined);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setStatus('loading');
    void readHeaderSuggestions(loadGlobalHeaderSuggestions, text, locale, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setSuggestions(page);
        setStatus(page.subjects.length ? 'ready' : 'empty');
        setActiveIndex(-1);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setSuggestions(undefined);
        setStatus('unavailable');
      });
    return () => {
      controller.abort();
      if (request.current === controller) request.current = undefined;
    };
  }, [query, locale]);

  const choose = (subject: SuggestionResult['subjects'][number]) => {
    cancel();
    const text = localizedLabel(subject.labels, locale).text || subject.id;
    onSelection({ id: subject.id, label: text, type: subject.type });
    onPendingChange(false);
    setQuery('');
    inputRef.current?.setCustomValidity('');
  };
  const statusText =
    status === 'loading'
      ? m.header_search_loading({}, options)
      : status === 'empty'
        ? m.search_no_suggestions({}, options)
        : status === 'unavailable'
          ? m.search_suggestions_unavailable({}, options)
          : undefined;
  const describedBy = [helpId, `${inputId}-status`, errorId].filter(Boolean).join(' ');

  return (
    <div className="grid gap-1 text-sm font-medium">
      <label htmlFor={inputId}>{label}</label>
      <input
        ref={inputRef}
        id={inputId}
        className={fieldClass}
        type="search"
        autoComplete="off"
        placeholder={m.search_placeholder({}, options)}
        value={query}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={query.trim().length >= 2 && status !== 'idle'}
        aria-controls={listId}
        aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => {
          cancel();
          const text = event.currentTarget.value;
          setQuery(text);
          onSelection(undefined);
          onPendingChange(Boolean(text.trim()));
        }}
        onKeyDown={(event) => {
          const count = suggestions?.subjects.length ?? 0;
          if (event.key === 'ArrowDown' && count) {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, count - 1));
          } else if (event.key === 'ArrowUp' && count) {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter' && active) {
            event.preventDefault();
            choose(active);
          } else if (event.key === 'Escape') {
            cancel();
            setQuery('');
            onPendingChange(false);
            inputRef.current?.setCustomValidity('');
          }
        }}
      />
      <input type="hidden" name={name} value={selection?.id ?? ''} />
      <span id={helpId} className="font-normal text-muted-foreground">
        {help}
      </span>
      {selection && (
        <div
          role="group"
          aria-label={label}
          className="flex flex-wrap items-center gap-2 rounded-md border p-2 font-normal"
        >
          <span>{selection.label ?? m.search_suggestions_unavailable({}, options)}</span>
          {selection.type && <span className="text-muted-foreground">{selection.type}</span>}
          <code className="text-xs text-muted-foreground">{selection.id}</code>
          <button
            type="button"
            className="underline"
            onClick={() => {
              cancel();
              onSelection(undefined);
              onPendingChange(false);
            }}
          >
            {m.library_subject_clear({}, options)}
          </button>
        </div>
      )}
      {query && !selection && (
        <button
          type="button"
          className="justify-self-start underline"
          onClick={() => {
            cancel();
            setQuery('');
            onPendingChange(false);
          }}
        >
          {m.library_subject_clear({}, options)}
        </button>
      )}
      <p id={`${inputId}-status`} role="status" aria-live="polite" className="font-normal text-muted-foreground">
        {statusText}
      </p>
      {status === 'ready' && suggestions && (
        <ul
          id={listId}
          role="listbox"
          aria-label={m.header_search_suggestions({}, options)}
          className="rounded-md border"
        >
          {suggestions.subjects.slice(0, HEADER_SUGGESTION_LIMIT).map((subject, index) => {
            const subjectLabel = localizedLabel(subject.labels, locale);
            const typeLabel = localizedLabel(suggestions.types[subject.type] ?? {}, locale);
            return (
              <li
                key={subject.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={activeIndex === index}
                className="cursor-pointer px-3 py-2 hover:bg-muted"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(subject)}
              >
                <span lang={subjectLabel.lang}>{subjectLabel.text || subject.id}</span>
                <span className="text-muted-foreground"> · {typeLabel.text || subject.type}</span>
                <code className="ml-2 text-xs text-muted-foreground">{subject.id}</code>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ReleaseSearchFormView({
  parsed,
  types,
  locale,
  selections,
}: {
  parsed: ParsedReleaseSearch;
  types: ReleaseSearchType[];
  locale: string;
  selections?: ReleaseSearchSelections;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const [draft, setDraft] = useState(() => draftFor(parsed));
  const [subjectSelections, setSubjectSelections] = useState<ReleaseSearchSelections>(() => ({
    ...(selections?.platform
      ? { platform: selections.platform }
      : parsed.form.platform
        ? { platform: { id: parsed.form.platform } }
        : {}),
    ...(selections?.developer
      ? { developer: selections.developer }
      : parsed.form.developer
        ? { developer: { id: parsed.form.developer } }
        : {}),
    ...(selections?.publisher
      ? { publisher: selections.publisher }
      : parsed.form.publisher
        ? { publisher: { id: parsed.form.publisher } }
        : {}),
  }));
  const [pendingSubjects, setPendingSubjects] = useState<Set<SubjectField>>(() => new Set());
  const [serverErrors, setServerErrors] = useState<Set<keyof ReleaseSearchForm>>(
    () => new Set(parsed.invalid.filter((field): field is keyof ReleaseSearchForm => field !== 'cursor')),
  );
  const [corrections, setCorrections] = useState<Set<SemanticField>>(() => new Set());
  const [meaningBaseline, setMeaningBaseline] = useState<Record<SemanticField, string>>(
    () =>
      Object.fromEntries(
        semanticFields.map((field) => [
          field,
          criteriaMeaning(field, parsed.form.subtype, parsed.form.platform, types),
        ]),
      ) as Record<SemanticField, string>,
  );
  const [focusAttempt, setFocusAttempt] = useState(0);
  const summary = useRef<HTMLDivElement>(null);
  const current = parseReleaseSearchDraft(draftInput(draft), types, locale);
  const controls = current.controls;
  const blocked: (keyof ReleaseSearchForm)[] = [];
  if (draft.form.platform && !controls?.platform) blocked.push('platform');
  if (
    draft.form.releaseLanguage &&
    (draft.form.platform ? !controls?.platform?.languageQualifier : !controls?.language)
  )
    blocked.push('releaseLanguage');
  if (draft.form.gte && !controls?.date) blocked.push('gte');
  if (draft.form.lte && !controls?.date) blocked.push('lte');
  if (draft.form.ageGte && !controls?.ageRating) blocked.push('ageGte');
  if (draft.form.ageLte && !controls?.ageRating) blocked.push('ageLte');
  if (draft.form.ageUnit && (!controls?.ageRating || !controls.ageRating.units.includes(draft.form.ageUnit)))
    blocked.push('ageUnit');
  for (const role of ['developer', 'publisher'] as const)
    if (draft.form[role] && !controls?.producers.some((producer) => producer.role === role)) blocked.push(role);
  const errors = [
    ...new Set<keyof ReleaseSearchForm>([
      ...current.invalid.filter((field): field is keyof ReleaseSearchForm => field !== 'cursor'),
      ...serverErrors,
      ...blocked,
      ...corrections,
      ...pendingSubjects,
    ]),
  ];
  const issueId = (field: keyof ReleaseSearchForm) => `release-search-${field}-error`;
  const fieldLabel = (field: keyof ReleaseSearchForm) => {
    const labels: Record<keyof ReleaseSearchForm, string> = {
      subtype: m.release_search_subtype({}, options),
      q: m.release_search_text({}, options),
      platform: m.release_search_platform({}, options),
      releaseLanguage: m.release_search_languages({}, options),
      gte: m.release_search_date_lower({}, options),
      lte: m.release_search_date_upper({}, options),
      ageGte: m.release_search_age_lower({}, options),
      ageLte: m.release_search_age_upper({}, options),
      ageUnit: m.release_search_age_unit({}, options),
      developer: m.release_search_developer({}, options),
      publisher: m.release_search_publisher({}, options),
      language: m.condition_languages_label({}, options),
      sort: m.release_search_sort({}, options),
      threshold: m.release_search_spoilers({}, options),
      condition: m.release_search_condition({}, options),
    };
    return labels[field];
  };
  const issue = (field: keyof ReleaseSearchForm) =>
    corrections.has(field as SemanticField)
      ? m.release_search_correction_required({ field: fieldLabel(field) }, options)
      : issueText(field, draft, controls, locale);
  const clearServerError = (field: keyof ReleaseSearchForm) =>
    setServerErrors((currentErrors) => {
      if (!currentErrors.has(field)) return currentErrors;
      const next = new Set(currentErrors);
      next.delete(field);
      return next;
    });
  const setLanguageTags = (languageTags: string[]) => {
    setDraft((currentDraft) => ({ ...currentDraft, languageTags }));
    clearServerError('language');
  };
  const setField = <K extends keyof ReleaseSearchForm>(field: K, value: ReleaseSearchForm[K]) => {
    setDraft((currentDraft) => ({ ...currentDraft, form: { ...currentDraft.form, [field]: value } }));
    clearServerError(field);
    if ((semanticFields as readonly string[]).includes(field)) {
      const semanticField = field as SemanticField;
      setMeaningBaseline((currentBaseline) => ({
        ...currentBaseline,
        [semanticField]: criteriaMeaning(semanticField, draft.form.subtype, draft.form.platform, types),
      }));
      setCorrections((currentCorrections) => {
        const next = new Set(currentCorrections);
        next.delete(semanticField);
        return next;
      });
    }
  };
  const setSubject = (field: SubjectField, value?: ReleaseSearchSubjectSelection) => {
    if (field === 'platform' && draft.form.releaseLanguage) {
      const meaning = criteriaMeaning('releaseLanguage', draft.form.subtype, value?.id ?? '', types);
      setCorrections((currentCorrections) => {
        const next = new Set(currentCorrections);
        if (meaningBaseline.releaseLanguage !== meaning) next.add('releaseLanguage');
        else next.delete('releaseLanguage');
        return next;
      });
    }
    setSubjectSelections((currentSelections) => {
      const next = { ...currentSelections };
      if (value) next[field] = value;
      else delete next[field];
      return next;
    });
    setField(field, value?.id ?? '');
  };
  const setSubjectPending = (field: SubjectField, pending: boolean) => {
    setPendingSubjects((currentPending) => {
      const next = new Set(currentPending);
      if (pending) next.add(field);
      else next.delete(field);
      return next;
    });
  };
  const changeSubtype = (subtype: string) => {
    setCorrections((currentCorrections) => {
      const next = new Set(currentCorrections);
      for (const field of semanticFields) {
        if (draft.form[field] && meaningBaseline[field] !== criteriaMeaning(field, subtype, draft.form.platform, types))
          next.add(field);
        else next.delete(field);
      }
      return next;
    });
    setField('subtype', subtype);
  };
  const clear = (field: keyof ReleaseSearchForm) => {
    if (field === 'platform' || field === 'developer' || field === 'publisher') {
      setSubject(field, undefined);
      setSubjectPending(field, false);
    } else if (field === 'language') setLanguageTags([]);
    else if (field !== 'subtype') setField(field, '');
  };
  const fieldInput = (
    name: Exclude<keyof ReleaseSearchForm, 'subtype' | 'language' | 'platform' | 'developer' | 'publisher'>,
    label: string,
    help?: string,
    inputMode?: 'decimal',
  ) => {
    const id = `release-search-${name}`;
    const invalid = errors.includes(name);
    const helpId = `${id}-help`;
    const dateText = name === 'gte' || name === 'lte';
    const describedBy = [
      help ? helpId : undefined,
      dateText ? `${id}-precision` : undefined,
      invalid ? issueId(name) : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    const precisionText = dateText ? calendarPrecision(draft.form[name], locale) : undefined;
    return (
      <div className="grid gap-1 text-sm font-medium">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          className={fieldClass}
          name={name}
          type="text"
          inputMode={inputMode}
          value={draft.form[name]}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => setField(name, event.currentTarget.value)}
        />
        {help && (
          <span id={helpId} className="font-normal text-muted-foreground">
            {help}
          </span>
        )}
        {dateText && (
          <span id={`${id}-precision`} className="font-normal text-muted-foreground">
            {precisionText} · {m.condition_calendar_help({}, options)}
          </span>
        )}
        {invalid && (
          <p id={issueId(name)} className="font-normal text-destructive">
            {issue(name)}
          </p>
        )}
        {invalid && draft.form[name] !== '' && (
          <button type="button" className="justify-self-start font-normal underline" onClick={() => clear(name)}>
            {m.library_subject_clear({}, options)}
          </button>
        )}
      </div>
    );
  };
  const subjectPicker = (name: SubjectField, label: string) => (
    <>
      <ReleaseSearchSubjectPicker
        name={name}
        label={label}
        help={m.release_search_subject_help({}, options)}
        locale={locale}
        invalid={errors.includes(name)}
        {...(errors.includes(name) ? { errorId: issueId(name) } : {})}
        selection={subjectSelections[name]}
        onSelection={(selection) => setSubject(name, selection)}
        onPendingChange={(pending) => setSubjectPending(name, pending)}
      />
      {errors.includes(name) && (
        <p id={issueId(name)} className="text-sm text-destructive">
          {issue(name)}
        </p>
      )}
    </>
  );
  const edited =
    Object.keys(parsed.form).some((key) => {
      if (key === 'language') return false;
      const field = key as keyof ReleaseSearchForm;
      return draft.form[field] !== parsed.form[field];
    }) ||
    JSON.stringify(draft.languageTags.length ? draft.languageTags : parsed.search.languages) !==
      JSON.stringify(parsed.search.languages) ||
    corrections.size > 0 ||
    pendingSubjects.size > 0;

  useEffect(() => {
    if (focusAttempt > 0 && errors.length) summary.current?.focus();
  }, [focusAttempt, errors.join('|')]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    if (!errors.length) return;
    event.preventDefault();
    setFocusAttempt((attempt) => attempt + 1);
  };

  return (
    <form
      method="get"
      action={`/${encodeURIComponent(locale)}/search/releases`}
      onSubmit={submit}
      className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
    >
      {edited && (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground sm:col-span-2">
          {m.release_search_draft_notice({}, options)}
        </p>
      )}
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_subtype({}, options)}</span>
        <select
          id="release-search-subtype"
          className={fieldClass}
          name="subtype"
          value={draft.form.subtype}
          aria-invalid={errors.includes('subtype') || undefined}
          aria-describedby={errors.includes('subtype') ? issueId('subtype') : undefined}
          onChange={(event) => changeSubtype(event.currentTarget.value)}
        >
          {!types.some((type) => type.id === draft.form.subtype) && (
            <option value={draft.form.subtype}>{draft.form.subtype}</option>
          )}
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </select>
        {errors.includes('subtype') && <span id={issueId('subtype')}>{issue('subtype')}</span>}
      </label>
      {fieldInput('q', m.release_search_text({}, options))}
      {(controls?.platform || draft.form.platform) && (
        <div className="grid gap-1" data-criteria-field="platform">
          {subjectPicker('platform', m.release_search_platform({}, options))}
        </div>
      )}
      {(controls?.language || controls?.platform?.languageQualifier || draft.form.releaseLanguage) && (
        <div className="grid gap-1 text-sm font-medium">
          <label htmlFor="release-search-releaseLanguage">{m.release_search_languages({}, options)}</label>
          <input
            id="release-search-releaseLanguage"
            className={fieldClass}
            name="releaseLanguage"
            value={draft.form.releaseLanguage}
            aria-invalid={errors.includes('releaseLanguage') || undefined}
            aria-describedby={errors.includes('releaseLanguage') ? issueId('releaseLanguage') : undefined}
            onChange={(event) => setField('releaseLanguage', event.currentTarget.value)}
          />
          {errors.includes('releaseLanguage') && (
            <p id={issueId('releaseLanguage')} className="font-normal text-destructive">
              {issue('releaseLanguage')}
            </p>
          )}
          {errors.includes('releaseLanguage') && draft.form.releaseLanguage && (
            <button
              type="button"
              className="justify-self-start font-normal underline"
              onClick={() => clear('releaseLanguage')}
            >
              {m.library_subject_clear({}, options)}
            </button>
          )}
        </div>
      )}
      <div
        id="release-search-language"
        tabIndex={-1}
        aria-invalid={errors.includes('language') || undefined}
        aria-describedby={errors.includes('language') ? issueId('language') : undefined}
      >
        <ConditionLanguages
          languages={draft.languageTags}
          locale={locale}
          invalid={errors.includes('language')}
          {...(errors.includes('language') ? { errorId: issueId('language') } : {})}
          onChange={setLanguageTags}
        />
        {draft.languageTags.map((tag, index) => (
          <input key={`${index}:${tag}`} type="hidden" name="language" value={tag} />
        ))}
        {errors.includes('language') && (
          <p id={issueId('language')} className="text-sm text-destructive">
            {issue('language')}
          </p>
        )}
      </div>
      {(controls?.date || draft.form.gte || draft.form.lte) && (
        <>
          {fieldInput('gte', m.release_search_date_lower({}, options))}
          {fieldInput('lte', m.release_search_date_upper({}, options))}
        </>
      )}
      {(controls?.ageRating || draft.form.ageGte || draft.form.ageLte || draft.form.ageUnit) && (
        <>
          {fieldInput(
            'ageGte',
            m.release_search_age_lower({}, options),
            m.release_search_age_help({}, options),
            'decimal',
          )}
          {fieldInput(
            'ageLte',
            m.release_search_age_upper({}, options),
            m.release_search_age_help({}, options),
            'decimal',
          )}
          <div className="grid gap-1 text-sm font-medium">
            <label htmlFor="release-search-ageUnit">{m.release_search_age_unit({}, options)}</label>
            <select
              id="release-search-ageUnit"
              className={fieldClass}
              name="ageUnit"
              value={draft.form.ageUnit}
              aria-invalid={errors.includes('ageUnit') || undefined}
              aria-describedby={errors.includes('ageUnit') ? issueId('ageUnit') : undefined}
              onChange={(event) => setField('ageUnit', event.currentTarget.value)}
            >
              <option value="">—</option>
              {draft.form.ageUnit && !controls?.ageRating?.units.includes(draft.form.ageUnit) && (
                <option value={draft.form.ageUnit}>{unitLabel(draft.form.ageUnit, locale)}</option>
              )}
              {controls?.ageRating?.units.map((unit) => (
                <option key={unit} value={unit}>
                  {unitLabel(unit, locale)}
                </option>
              ))}
            </select>
            {errors.includes('ageUnit') && (
              <p id={issueId('ageUnit')} className="font-normal text-destructive">
                {issue('ageUnit')}
              </p>
            )}
          </div>
        </>
      )}
      {(['developer', 'publisher'] as const).map(
        (role) =>
          (controls?.producers.some((producer) => producer.role === role) || draft.form[role]) && (
            <div key={role} className="grid gap-1" data-criteria-field={role}>
              {subjectPicker(
                role,
                role === 'developer'
                  ? m.release_search_developer({}, options)
                  : m.release_search_publisher({}, options),
              )}
            </div>
          ),
      )}
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_sort({}, options)}</span>
        <select
          id="release-search-sort"
          className={fieldClass}
          name="sort"
          value={draft.form.sort}
          aria-invalid={errors.includes('sort') || undefined}
          aria-describedby={errors.includes('sort') ? issueId('sort') : undefined}
          onChange={(event) => setField('sort', event.currentTarget.value)}
        >
          {!['name', 'relevance'].includes(draft.form.sort) && (
            <option value={draft.form.sort}>{draft.form.sort}</option>
          )}
          <option value="name">{m.release_search_sort_name({}, options)}</option>
          <option value="relevance">{m.release_search_sort_relevance({}, options)}</option>
        </select>
        {errors.includes('sort') && <span id={issueId('sort')}>{issue('sort')}</span>}
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_spoilers({}, options)}</span>
        <select
          id="release-search-threshold"
          className={fieldClass}
          name="threshold"
          value={draft.form.threshold}
          aria-invalid={errors.includes('threshold') || undefined}
          aria-describedby={errors.includes('threshold') ? issueId('threshold') : undefined}
          onChange={(event) => setField('threshold', event.currentTarget.value)}
        >
          {!['0', '1', '2'].includes(draft.form.threshold) && (
            <option value={draft.form.threshold}>{draft.form.threshold}</option>
          )}
          <option value="0">{m.release_search_spoilers_0({}, options)}</option>
          <option value="1">{m.release_search_spoilers_1({}, options)}</option>
          <option value="2">{m.release_search_spoilers_2({}, options)}</option>
        </select>
        {errors.includes('threshold') && <span id={issueId('threshold')}>{issue('threshold')}</span>}
      </label>
      {draft.form.condition && (
        <div className="grid gap-1 text-sm font-medium sm:col-span-2">
          <label htmlFor="release-search-condition">{m.release_search_condition({}, options)}</label>
          <textarea
            id="release-search-condition"
            className="min-h-20 rounded-md border bg-background px-3 py-2 font-normal"
            name="condition"
            value={draft.form.condition}
            aria-invalid={errors.includes('condition') || undefined}
            aria-describedby={errors.includes('condition') ? issueId('condition') : undefined}
            onChange={(event) => setField('condition', event.currentTarget.value)}
          />
          {errors.includes('condition') && (
            <p id={issueId('condition')} className="font-normal text-destructive">
              {issue('condition')}
            </p>
          )}
          {errors.includes('condition') && (
            <button
              type="button"
              className="justify-self-start font-normal underline"
              onClick={() => clear('condition')}
            >
              {m.library_subject_clear({}, options)}
            </button>
          )}
        </div>
      )}
      {errors.length > 0 && (
        <div
          ref={summary}
          id="release-search-errors"
          role="alert"
          tabIndex={-1}
          className="text-sm text-destructive sm:col-span-2"
        >
          <p>{m.release_search_invalid({}, options)}</p>
          <ul className="list-disc pl-5">
            {errors.map((field) => (
              <li key={field}>
                <a
                  href={`#release-search-${field}`}
                  className="underline"
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById(`release-search-${field}`)?.focus();
                  }}
                >
                  {fieldLabel(field)}
                </a>
                {`: ${issue(field)}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="sm:col-span-2">
        <button type="submit" className={buttonVariants()}>
          {m.release_search_apply({}, options)}
        </button>
      </div>
    </form>
  );
}
