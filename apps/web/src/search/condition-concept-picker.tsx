import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FilterDocument, FilterStatement } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel, FieldSet } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { conditionConceptReferenceForRequest, conditionConceptSelection } from './condition-concept-model';
import {
  readConditionConceptReference,
  searchConditionConcepts,
  type ConditionConceptChoice,
  type ConditionConceptLookup,
  type ConditionConceptReference,
  type ConditionConceptSuggestions,
} from './condition-concept';

type ConceptFilterDocument = { statement: Extract<FilterStatement, { in: readonly string[] }> };
type SearchView =
  | Readonly<{ owner: string; phase: 'loading'; retryable: boolean }>
  | Readonly<{ owner: string; phase: 'settled'; result: ConditionConceptSuggestions }>;
type ReferenceView =
  | Readonly<{ owner: string; phase: 'loading'; retryable: boolean }>
  | Readonly<{ owner: string; phase: 'settled'; result: ConditionConceptReference }>;
type FocusIntent =
  | Readonly<{ kind: 'open'; visit: number }>
  | Readonly<{ kind: 'close'; visit: number }>
  | Readonly<{ kind: 'search'; owner: string; from: HTMLElement }>
  | Readonly<{ kind: 'reference'; owner: string; from: HTMLElement }>;

function ownsFocusOrLostTrigger(from: HTMLElement): boolean {
  const active = document.activeElement;
  return active === from || (!from.isConnected && (active === document.body || active === document.documentElement));
}

type Props = {
  value: FilterDocument;
  lookup: ConditionConceptLookup;
  locale: string;
  disabled: boolean;
  preventImplicitSubmit?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined;
  onChange(value: FilterDocument): void;
};

function referenceMessage(
  reference: ConditionConceptReference | undefined,
  options: { locale: (typeof locales)[number] },
) {
  if (!reference || reference.status === 'ready') return undefined;
  if (reference.status === 'preparing') return m.condition_concept_preparing({}, options);
  if (reference.status === 'restart') return m.condition_concept_restart({}, options);
  if (reference.status === 'unsupported') return m.condition_concept_unsupported({}, options);
  if (reference.status === 'refused') return m.condition_concept_refused({}, options);
  return m.condition_concept_unavailable({}, options);
}

function searchMessage(result: ConditionConceptSuggestions | undefined, options: { locale: (typeof locales)[number] }) {
  if (!result || result.status === 'ready') return undefined;
  if (result.status === 'preparing') return m.condition_concept_search_preparing({}, options);
  if (result.status === 'restart') return m.condition_concept_restart({}, options);
  if (result.status === 'unsupported') return m.condition_concept_unsupported({}, options);
  if (result.status === 'refused') return m.condition_concept_refused({}, options);
  return m.condition_concept_search_unavailable({}, options);
}

export function ConditionConceptPicker({ value, lookup, locale, disabled, preventImplicitSubmit, onChange }: Props) {
  if (!('statement' in value) || !('in' in value.statement)) return null;
  return (
    <ConceptPicker
      value={{ statement: value.statement }}
      lookup={lookup}
      locale={locale}
      disabled={disabled}
      preventImplicitSubmit={preventImplicitSubmit}
      onChange={onChange}
    />
  );
}

function ConceptPicker({
  value,
  lookup,
  locale,
  disabled,
  preventImplicitSubmit,
  onChange,
}: Omit<Props, 'value'> & { value: ConceptFilterDocument }) {
  const statement = value.statement;
  const existingId = statement.concept ? statement.in[0] : undefined;
  const options = useMemo(() => ({ locale: locales.find((item) => item === locale) ?? 'en' }), [locale]);
  const id = useId();
  const searchInputId = `${id}-concept-search`;
  const schemeSelectId = `${id}-concept-scheme`;
  const modeSelectId = `${id}-concept-match`;
  const searchStatusId = `${id}-concept-search-status`;
  const referenceStatusId = `${id}-concept-reference-status`;
  const resultsId = `${id}-concept-results`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [queryEpoch, setQueryEpoch] = useState(0);
  const queryEpochRef = useRef(0);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const searchAttemptRef = useRef(0);
  const [referenceAttempt, setReferenceAttempt] = useState(0);
  const referenceAttemptRef = useRef(0);
  const [visitEpoch, setVisitEpoch] = useState(0);
  const visitEpochRef = useRef(0);
  const hasOpened = useRef(false);
  const searchRun = useRef(0);
  const referenceRun = useRef(0);
  const focusIntent = useRef<FocusIntent | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const schemeSelect = useRef<HTMLSelectElement>(null);
  const searchStatusElement = useRef<HTMLParagraphElement>(null);
  const referenceStatusElement = useRef<HTMLParagraphElement>(null);
  const resultsElement = useRef<HTMLUListElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const [searchView, setSearchView] = useState<SearchView>();
  const searchViewRef = useRef<SearchView | undefined>(undefined);
  searchViewRef.current = searchView;
  const [referenceView, setReferenceView] = useState<ReferenceView>();
  const referenceViewRef = useRef<ReferenceView | undefined>(undefined);
  referenceViewRef.current = referenceView;
  const lookupIdentity = JSON.stringify([
    lookup.lifetimeKey ?? lookup.key,
    lookup.key,
    lookup.enabled,
    lookup.filter,
    lookup.releaseDigest,
    locale,
  ]);
  const selectionOwner = JSON.stringify([
    lookupIdentity,
    statement.property,
    existingId ?? null,
    statement.concept?.scheme ?? null,
    statement.concept?.includeChildren ?? null,
  ]);
  const [choiceState, setChoiceState] = useState<{ owner: string; value: ConditionConceptChoice }>();
  const choice = choiceState?.owner === selectionOwner ? choiceState.value : undefined;
  const [schemeState, setSchemeState] = useState<{ owner: string; value: string }>(() => ({
    owner: selectionOwner,
    value: statement.concept?.scheme ?? '',
  }));
  const [modeState, setModeState] = useState<{ owner: string; value: '' | 'exact' | 'descendants' }>(() => ({
    owner: selectionOwner,
    value: statement.concept ? (statement.concept.includeChildren ? 'descendants' : 'exact') : '',
  }));
  const scheme = schemeState.owner === selectionOwner ? schemeState.value : (statement.concept?.scheme ?? '');
  const mode =
    modeState.owner === selectionOwner
      ? modeState.value
      : statement.concept
        ? statement.concept.includeChildren
          ? 'descendants'
          : 'exact'
        : '';
  const currentSearchOwner = useRef('');
  const currentReferenceOwner = useRef('');
  const targetId = choice?.id ?? existingId;
  const makeSearchOwner = (text: string, epoch: number, attempt: number) =>
    JSON.stringify([lookupIdentity, text, epoch, attempt]);
  const makeReferenceOwner = (target: string | undefined, isOpen: boolean, visit: number, attempt: number) =>
    JSON.stringify([lookupIdentity, target ?? null, isOpen, visit, attempt]);
  const nextSearchOwner = makeSearchOwner(query, queryEpoch, searchAttempt);
  const nextReferenceOwner = makeReferenceOwner(targetId, open, visitEpoch, referenceAttempt);
  currentSearchOwner.current = nextSearchOwner;
  currentReferenceOwner.current = nextReferenceOwner;
  const currentSearchView = searchView?.owner === nextSearchOwner ? searchView : undefined;
  const searchResult = currentSearchView?.phase === 'settled' ? currentSearchView.result : undefined;
  const choices = searchResult?.status === 'ready' ? searchResult.choices : [];
  const searchLoading = currentSearchView?.phase === 'loading';
  const currentReferenceView = referenceView?.owner === nextReferenceOwner ? referenceView : undefined;
  const reference =
    currentReferenceView?.phase === 'settled'
      ? conditionConceptReferenceForRequest(nextReferenceOwner, targetId ?? '', {
          owner: currentReferenceView.owner,
          value: currentReferenceView.result,
        })
      : undefined;
  const referenceLoading = currentReferenceView?.phase === 'loading';
  const readyReference = reference?.status === 'ready' ? reference : undefined;
  const selectedScheme = readyReference?.schemes.find((entry) => entry.id === scheme);
  const currentMeaning = statement.concept;
  const currentReference = !choice || choice.id === existingId ? readyReference : undefined;
  const currentConceptLabel = currentReference?.label || existingId;
  const currentSchemeLabel =
    currentReference?.schemes.find((entry) => entry.id === currentMeaning?.scheme)?.label || currentMeaning?.scheme;
  const choiceAllowed = !!choice || !!existingId;
  const canApply =
    !disabled &&
    lookup.enabled &&
    choiceAllowed &&
    !!readyReference &&
    !!selectedScheme &&
    (mode === 'exact' || mode === 'descendants');
  const blockedMessage =
    lookup.blocked === 'scope'
      ? m.condition_concept_scope_unavailable({}, options)
      : lookup.blocked === 'private'
        ? m.condition_concept_private_unavailable({}, options)
        : lookup.blocked === 'metadata'
          ? m.condition_concept_metadata_unavailable({}, options)
          : undefined;
  const message = referenceLoading ? m.condition_concept_reading({}, options) : referenceMessage(reference, options);
  const searchStatusMessage = searchLoading
    ? m.condition_concept_searching({}, options)
    : searchMessage(searchResult, options);
  const showSearchRetry =
    searchResult?.status === 'preparing' ||
    searchResult?.status === 'unavailable' ||
    (searchLoading && currentSearchView?.phase === 'loading' && currentSearchView.retryable);
  const showReferenceRetry =
    reference?.status === 'preparing' ||
    reference?.status === 'unavailable' ||
    (referenceLoading && currentReferenceView?.phase === 'loading' && currentReferenceView.retryable);
  const searchRetryPending = searchLoading && currentSearchView?.phase === 'loading' && currentSearchView.retryable;
  const referenceRetryPending =
    referenceLoading && currentReferenceView?.phase === 'loading' && currentReferenceView.retryable;

  const moveVisit = () => {
    const next = visitEpochRef.current + 1;
    visitEpochRef.current = next;
    setVisitEpoch(next);
    return next;
  };
  const close = () => {
    const visit = moveVisit();
    searchRun.current += 1;
    referenceRun.current += 1;
    if (searchViewRef.current?.phase === 'loading') {
      searchViewRef.current = undefined;
      setSearchView(undefined);
    }
    focusIntent.current = { kind: 'close', visit };
    setChoiceState(undefined);
    setSchemeState({ owner: selectionOwner, value: currentMeaning?.scheme ?? '' });
    setModeState({
      owner: selectionOwner,
      value: currentMeaning ? (currentMeaning.includeChildren ? 'descendants' : 'exact') : '',
    });
    setOpen(false);
  };
  const toggle = () => {
    if (open) {
      close();
      return;
    }
    const visit = moveVisit();
    searchRun.current += 1;
    referenceRun.current += 1;
    hasOpened.current = true;
    focusIntent.current = { kind: 'open', visit };
    setChoiceState(undefined);
    setSchemeState({ owner: selectionOwner, value: currentMeaning?.scheme ?? '' });
    setModeState({
      owner: selectionOwner,
      value: currentMeaning ? (currentMeaning.includeChildren ? 'descendants' : 'exact') : '',
    });
    setOpen(true);
  };
  const pick = (next: ConditionConceptChoice, from: HTMLElement) => {
    const sameIdentity = (choice?.id ?? existingId) === next.id;
    const attempt = referenceAttemptRef.current + 1;
    referenceAttemptRef.current = attempt;
    setReferenceAttempt(attempt);
    referenceRun.current += 1;
    setChoiceState({ owner: selectionOwner, value: next });
    if (!sameIdentity) {
      setSchemeState({ owner: selectionOwner, value: '' });
      setModeState({ owner: selectionOwner, value: '' });
    }
    const owner = makeReferenceOwner(next.id, open, visitEpoch, attempt);
    const loading: ReferenceView = { owner, phase: 'loading', retryable: false };
    referenceViewRef.current = loading;
    setReferenceView(loading);
    focusIntent.current = { kind: 'reference', owner, from };
  };
  const retrySearch = (from: HTMLElement) => {
    if (searchRetryPending || (searchResult?.status !== 'preparing' && searchResult?.status !== 'unavailable')) return;
    const attempt = searchAttemptRef.current + 1;
    searchAttemptRef.current = attempt;
    searchRun.current += 1;
    const owner = makeSearchOwner(query, queryEpoch, attempt);
    const loading: SearchView = { owner, phase: 'loading', retryable: true };
    searchViewRef.current = loading;
    setSearchView(loading);
    setSearchAttempt(attempt);
    focusIntent.current = { kind: 'search', owner, from };
  };
  const retryReference = (from: HTMLElement) => {
    if (
      referenceRetryPending ||
      (reference?.status !== 'preparing' && reference?.status !== 'unavailable') ||
      !targetId
    )
      return;
    const attempt = referenceAttemptRef.current + 1;
    referenceAttemptRef.current = attempt;
    referenceRun.current += 1;
    const owner = makeReferenceOwner(targetId, open, visitEpoch, attempt);
    const loading: ReferenceView = { owner, phase: 'loading', retryable: true };
    referenceViewRef.current = loading;
    setReferenceView(loading);
    setReferenceAttempt(attempt);
    focusIntent.current = { kind: 'reference', owner, from };
  };

  const requestLookup = useMemo<ConditionConceptLookup>(
    () => ({
      enabled: lookup.enabled,
      ...(lookup.filter ? { filter: lookup.filter } : {}),
      ...(lookup.releaseDigest ? { releaseDigest: lookup.releaseDigest } : {}),
      key: lookup.key,
      ...(lookup.lifetimeKey ? { lifetimeKey: lookup.lifetimeKey } : {}),
      ...(lookup.blocked ? { blocked: lookup.blocked } : {}),
    }),
    [lookup.enabled, lookup.filter, lookup.releaseDigest, lookup.key, lookup.lifetimeKey, lookup.blocked],
  );

  useEffect(() => {
    if (!open || !lookup.enabled || !lookup.filter || query.trim().length < 2) return;
    if (searchViewRef.current?.owner === nextSearchOwner && searchViewRef.current.phase === 'settled') return;
    const controller = new AbortController();
    let active = true;
    const run = ++searchRun.current;
    const retryable =
      searchViewRef.current?.owner === nextSearchOwner &&
      searchViewRef.current.phase === 'loading' &&
      searchViewRef.current.retryable;
    const loading: SearchView = { owner: nextSearchOwner, phase: 'loading', retryable };
    searchViewRef.current = loading;
    setSearchView(loading);
    void searchConditionConcepts(query, locale, controller.signal, requestLookup).then((result) => {
      if (
        active &&
        !controller.signal.aborted &&
        run === searchRun.current &&
        currentSearchOwner.current === nextSearchOwner
      ) {
        const settled: SearchView = { owner: nextSearchOwner, phase: 'settled', result };
        searchViewRef.current = settled;
        setSearchView(settled);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, lookup.enabled, lookup.filter, query, locale, requestLookup, nextSearchOwner]);

  const shouldReadReference =
    lookup.enabled && !!targetId && !!lookup.releaseDigest && (open || (!hasOpened.current && !!existingId));
  useEffect(() => {
    if (!shouldReadReference || !targetId) return;
    if (referenceViewRef.current?.owner === nextReferenceOwner && referenceViewRef.current.phase === 'settled') return;
    const controller = new AbortController();
    let active = true;
    const run = ++referenceRun.current;
    const retryable =
      referenceViewRef.current?.owner === nextReferenceOwner &&
      referenceViewRef.current.phase === 'loading' &&
      referenceViewRef.current.retryable;
    const loading: ReferenceView = { owner: nextReferenceOwner, phase: 'loading', retryable };
    referenceViewRef.current = loading;
    setReferenceView(loading);
    void readConditionConceptReference(targetId, locale, requestLookup, controller.signal).then((result) => {
      if (
        active &&
        !controller.signal.aborted &&
        run === referenceRun.current &&
        currentReferenceOwner.current === nextReferenceOwner
      ) {
        const settled: ReferenceView = { owner: nextReferenceOwner, phase: 'settled', result };
        referenceViewRef.current = settled;
        setReferenceView(settled);
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [shouldReadReference, nextReferenceOwner, targetId, locale, requestLookup]);

  useEffect(() => {
    const intent = focusIntent.current;
    if (!intent) return;
    if (intent.kind === 'open') {
      if (intent.visit !== visitEpoch || !open) {
        focusIntent.current = undefined;
        return;
      }
      searchInput.current?.focus();
      focusIntent.current = undefined;
      return;
    }
    if (intent.kind === 'close') {
      if (intent.visit !== visitEpoch || open) {
        focusIntent.current = undefined;
        return;
      }
      editButton.current?.focus();
      focusIntent.current = undefined;
      return;
    }
    if (intent.kind === 'search') {
      if (intent.owner !== nextSearchOwner) {
        focusIntent.current = undefined;
        return;
      }
      if (currentSearchView?.phase !== 'settled') return;
      if (!ownsFocusOrLostTrigger(intent.from)) {
        focusIntent.current = undefined;
        return;
      }
      if (currentSearchView.result.status === 'ready' && currentSearchView.result.choices.length)
        resultsElement.current?.focus();
      else searchStatusElement.current?.focus();
      focusIntent.current = undefined;
      return;
    }
    if (intent.owner !== nextReferenceOwner) {
      focusIntent.current = undefined;
      return;
    }
    if (currentReferenceView?.phase !== 'settled') return;
    if (!ownsFocusOrLostTrigger(intent.from)) {
      focusIntent.current = undefined;
      return;
    }
    if (currentReferenceView.result.status === 'ready' && currentReferenceView.result.schemes.length)
      schemeSelect.current?.focus();
    else referenceStatusElement.current?.focus();
    focusIntent.current = undefined;
  }, [open, visitEpoch, nextSearchOwner, nextReferenceOwner, currentSearchView, currentReferenceView]);

  return (
    <FieldSet className="min-w-0 gap-2 rounded-md border border-border/60 p-3" data-condition-concept>
      {currentMeaning && existingId && (
        <p className="text-sm" data-condition-concept-current>
          {m.condition_concept_current(
            {
              concept: currentConceptLabel || existingId,
              scheme: currentSchemeLabel || currentMeaning.scheme,
              match: currentMeaning.includeChildren
                ? m.condition_concept_descendants({}, options)
                : m.condition_concept_exact({}, options),
            },
            options,
          )}
        </p>
      )}
      {blockedMessage && (
        <p className="text-sm text-muted-foreground" role="status">
          {blockedMessage}
        </p>
      )}
      {message && (
        <p
          id={referenceStatusId}
          ref={referenceStatusElement}
          className="text-sm text-muted-foreground"
          role="status"
          tabIndex={-1}
          aria-busy={referenceLoading || undefined}
        >
          {message}
        </p>
      )}
      {showReferenceRetry && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-disabled={referenceRetryPending || undefined}
          onClick={(event) => retryReference(event.currentTarget)}
        >
          {m.condition_concept_retry_reference({}, options)}
        </Button>
      )}
      <Button
        ref={editButton}
        type="button"
        variant={currentMeaning ? 'outline' : 'ghost'}
        size="sm"
        disabled={disabled || !lookup.enabled}
        onClick={toggle}
      >
        {currentMeaning ? m.condition_concept_edit({}, options) : m.condition_concept_add({}, options)}
      </Button>
      {currentMeaning && !open && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            const { concept: _concept, ...remaining } = statement;
            onChange({ statement: remaining });
          }}
        >
          {m.condition_concept_use_literals({}, options)}
        </Button>
      )}
      {open && (
        <div className="grid min-w-0 gap-3">
          <Field>
            <FieldLabel htmlFor={searchInputId}>{m.condition_concept_search({}, options)}</FieldLabel>
            <Input
              ref={searchInput}
              id={searchInputId}
              value={query}
              onChange={(event) => {
                const epoch = queryEpochRef.current + 1;
                queryEpochRef.current = epoch;
                setQueryEpoch(epoch);
                searchRun.current += 1;
                if (searchViewRef.current?.phase === 'loading') {
                  searchViewRef.current = undefined;
                  setSearchView(undefined);
                }
                focusIntent.current = undefined;
                setQuery(event.currentTarget.value);
              }}
              onKeyDown={preventImplicitSubmit}
              disabled={disabled}
              autoComplete="off"
            />
          </Field>
          {searchStatusMessage && (
            <p
              id={searchStatusId}
              ref={searchStatusElement}
              className="text-sm text-muted-foreground"
              role="status"
              tabIndex={-1}
              aria-busy={searchLoading || undefined}
            >
              {searchStatusMessage}
            </p>
          )}
          {showSearchRetry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              aria-disabled={searchRetryPending || undefined}
              onClick={(event) => retrySearch(event.currentTarget)}
            >
              {m.condition_concept_retry_search({}, options)}
            </Button>
          )}
          {choices.length > 0 ? (
            <ul
              id={resultsId}
              ref={resultsElement}
              className="grid gap-1"
              tabIndex={-1}
              aria-label={m.condition_concept_results({}, options)}
            >
              {choices.map((entry) => (
                <li key={entry.id}>
                  <Button
                    type="button"
                    variant={choice?.id === entry.id ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={choice?.id === entry.id}
                    onClick={(event) => pick(entry, event.currentTarget)}
                    disabled={disabled}
                  >
                    {entry.label} <span className="text-muted-foreground">{entry.id}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : searchResult?.status === 'ready' ? (
            <p className="text-sm text-muted-foreground" role="status" tabIndex={-1} ref={searchStatusElement}>
              {m.condition_concept_no_results({}, options)}
            </p>
          ) : null}
          {(choice || existingId) && (
            <>
              <Field>
                <FieldLabel htmlFor={schemeSelectId}>{m.condition_concept_scheme({}, options)}</FieldLabel>
                <NativeSelect
                  ref={schemeSelect}
                  id={schemeSelectId}
                  value={scheme}
                  onChange={(event) => setSchemeState({ owner: selectionOwner, value: event.currentTarget.value })}
                  disabled={disabled || !readyReference}
                >
                  <NativeSelectOption value="">{m.condition_concept_choose_scheme({}, options)}</NativeSelectOption>
                  {scheme && !readyReference?.schemes.some((entry) => entry.id === scheme) && (
                    <NativeSelectOption value={scheme}>{scheme}</NativeSelectOption>
                  )}
                  {readyReference?.schemes.map((entry) => (
                    <NativeSelectOption key={entry.id} value={entry.id}>
                      {entry.label || entry.id}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={modeSelectId}>{m.condition_concept_match({}, options)}</FieldLabel>
                <NativeSelect
                  id={modeSelectId}
                  value={mode}
                  onChange={(event) =>
                    setModeState({
                      owner: selectionOwner,
                      value: event.currentTarget.value as '' | 'exact' | 'descendants',
                    })
                  }
                  disabled={disabled}
                >
                  <NativeSelectOption value="">{m.condition_concept_choose_match({}, options)}</NativeSelectOption>
                  <NativeSelectOption value="exact">{m.condition_concept_exact({}, options)}</NativeSelectOption>
                  <NativeSelectOption value="descendants">
                    {m.condition_concept_descendants({}, options)}
                  </NativeSelectOption>
                </NativeSelect>
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={!canApply}
                  onClick={() => {
                    const next = conditionConceptSelection(
                      value,
                      choice?.id ?? existingId!,
                      scheme,
                      mode === 'descendants',
                    );
                    if (next) {
                      onChange(next);
                      close();
                    }
                  }}
                >
                  {m.condition_concept_apply({}, options)}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={close}>
                  {m.condition_concept_cancel({}, options)}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </FieldSet>
  );
}
