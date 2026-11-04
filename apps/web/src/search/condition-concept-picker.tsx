import { useEffect, useMemo, useState } from 'react';
import type { FilterDocument, FilterStatement } from '@rezics/filter';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { Field, FieldLabel, FieldSet } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { conditionConceptSelection } from './condition-concept-model';
import {
  readConditionConceptReference,
  searchConditionConcepts,
  type ConditionConceptChoice,
  type ConditionConceptLookup,
  type ConditionConceptReference,
  type ConditionConceptSuggestions,
} from './condition-concept';

type ConceptFilterDocument = { statement: Extract<FilterStatement, { in: readonly string[] }> };

type Props = {
  value: ConceptFilterDocument;
  lookup: ConditionConceptLookup;
  locale: string;
  disabled: boolean;
  onChange(value: FilterDocument): void;
};

function referenceMessage(reference: ConditionConceptReference | undefined, options: { locale: (typeof locales)[number] }) {
  if (!reference || reference.status === 'ready') return undefined;
  if (reference.status === 'preparing') return m.condition_concept_preparing({}, options);
  if (reference.status === 'restart') return m.condition_concept_restart({}, options);
  if (reference.status === 'unsupported') return m.condition_concept_unsupported({}, options);
  if (reference.status === 'refused') return m.condition_concept_refused({}, options);
  return m.condition_concept_unavailable({}, options);
}

export function ConditionConceptPicker({ value, lookup, locale, disabled, onChange }: Props) {
  const statement = value.statement;
  const existingId = statement.concept ? statement.in[0] : undefined;
  const options = useMemo(
    () => ({ locale: locales.find((item) => item === locale) ?? 'en' }),
    [locale],
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<ConditionConceptChoice[]>([]);
  const [searchStatus, setSearchStatus] = useState<ConditionConceptSuggestions['status']>();
  const [choice, setChoice] = useState<ConditionConceptChoice>();
  const [scheme, setScheme] = useState(statement.concept?.scheme ?? '');
  const [mode, setMode] = useState<'' | 'exact' | 'descendants'>(
    statement.concept ? (statement.concept.includeChildren ? 'descendants' : 'exact') : '',
  );
  const [referenceState, setReferenceState] = useState<{
    owner: string;
    value: ConditionConceptReference;
  }>();
  const targetId = choice?.id ?? existingId;
  const targetOwner = `${lookup.key}:${targetId ?? ''}`;
  const reference = referenceState?.owner === targetOwner ? referenceState.value : undefined;
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

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setChoices([]);
    setSearchStatus(undefined);
    if (open && lookup.enabled && lookup.filter && query.trim().length >= 2) {
      void searchConditionConcepts(query, locale, controller.signal, lookup)
        .then((result) => {
          if (active && !controller.signal.aborted) {
            setChoices([...result.choices]);
            setSearchStatus(result.status);
          }
        })
        .catch(() => {
          if (active && !controller.signal.aborted) {
            setChoices([]);
            setSearchStatus('unavailable');
          }
        });
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, query, locale, lookup.enabled, lookup.filter, lookup.key]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    if (!lookup.enabled || !targetId || !lookup.releaseDigest) return () => controller.abort();
    setReferenceState(undefined);
    void readConditionConceptReference(targetId, locale, lookup, controller.signal)
      .then((next) => {
        if (active && !controller.signal.aborted) setReferenceState({ owner: targetOwner, value: next });
      })
      .catch(() => {
        if (active && !controller.signal.aborted)
          setReferenceState({ owner: targetOwner, value: { status: 'unavailable', id: targetId } });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [targetId, targetOwner, locale, lookup.enabled, lookup.releaseDigest, lookup.key]);

  const blockedMessage =
    lookup.blocked === 'scope'
      ? m.condition_concept_scope_unavailable({}, options)
      : lookup.blocked === 'private'
        ? m.condition_concept_private_unavailable({}, options)
        : lookup.blocked === 'metadata'
          ? m.condition_concept_metadata_unavailable({}, options)
          : undefined;
  const message = referenceMessage(reference, options);
  const searchMessage =
    searchStatus && searchStatus !== 'ready' ? referenceMessage({ status: searchStatus, id: '' }, options) : undefined;

  const pick = (next: ConditionConceptChoice) => {
    setChoice(next);
    setScheme('');
    setMode('');
  };

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
      {blockedMessage && <p className="text-sm text-muted-foreground" role="status">{blockedMessage}</p>}
      {message && <p className="text-sm text-muted-foreground" role="status">{message}</p>}
      {searchMessage && <p className="text-sm text-muted-foreground" role="status">{searchMessage}</p>}
      <Button
        type="button"
        variant={currentMeaning ? 'outline' : 'ghost'}
        size="sm"
        disabled={disabled || !lookup.enabled}
        onClick={() => {
          setOpen((previous) => !previous);
          setChoice(undefined);
          if (!currentMeaning) {
            setScheme('');
            setMode('');
          } else {
            setScheme(currentMeaning.scheme);
            setMode(currentMeaning.includeChildren ? 'descendants' : 'exact');
          }
        }}
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
            <FieldLabel>{m.condition_concept_search({}, options)}</FieldLabel>
            <Input value={query} onChange={(event) => setQuery(event.currentTarget.value)} disabled={disabled} />
          </Field>
          {choices.length > 0 ? (
            <ul className="grid gap-1" aria-label={m.condition_concept_results({}, options)}>
              {choices.map((entry) => (
                <li key={entry.id}>
                  <Button
                    type="button"
                    variant={choice?.id === entry.id ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => pick(entry)}
                    disabled={disabled}
                  >
                    {entry.label} <span className="text-muted-foreground">{entry.id}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : searchStatus === 'ready' ? (
            <p className="text-sm text-muted-foreground" role="status">{m.condition_concept_no_results({}, options)}</p>
          ) : null}
          {(choice || existingId) && (
            <>
              <Field>
                <FieldLabel>{m.condition_concept_scheme({}, options)}</FieldLabel>
                <NativeSelect
                  value={scheme}
                  onChange={(event) => setScheme(event.currentTarget.value)}
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
                <FieldLabel>{m.condition_concept_match({}, options)}</FieldLabel>
                <NativeSelect
                  value={mode}
                  onChange={(event) => setMode(event.currentTarget.value as '' | 'exact' | 'descendants')}
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
                      setOpen(false);
                    }
                  }}
                >
                  {m.condition_concept_apply({}, options)}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
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
