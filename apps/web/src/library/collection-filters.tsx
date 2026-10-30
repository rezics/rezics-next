import { useEffect, useState, type FormEvent } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { CollectionFilterParams } from './collection-filter-params';
import type { SuggestionResult } from '../search/suggestions';
import type { FilterDocument } from '@rezics/filter';
import { collectionFilterAddress } from './collection-filter-params';
import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@rezics/ui/shadcn/combobox';
import { SlidersHorizontalIcon } from 'lucide-react';
import { localizedLabel } from '../search/results';

export type CollectionFilterProperty = {
  id: string;
  label: string;
  datatype: string;
  unit?: string;
  targets?: readonly string[];
};

/** Shared rendered outcomes for filtered empty, unsupported, and preparing reads. */
export function CollectionFilterFeedback({
  id,
  filter,
  ignored = [],
  status,
  filterType,
  empty,
  unavailable = false,
  emptyLabel,
  buttonClass,
}: {
  id: string;
  filter?: FilterDocument | undefined;
  ignored?: string[] | undefined;
  status?: 'unsupported' | 'preparing' | 'failed' | undefined;
  filterType?: string | undefined;
  empty: boolean;
  unavailable?: boolean | undefined;
  emptyLabel: string;
  buttonClass?: string | undefined;
}) {
  return (
    <>
      {ignored.length ? <p role="status">{m.collection_filter_ignored({ filter: ignored.join(', ') })}</p> : null}
      {status === 'unsupported' ? <p role="status">{m.collection_filter_unsupported()}</p> : null}
      {status === 'failed' ? <p role="status">{m.collection_filter_failed()}</p> : null}
      {status === 'preparing' ? (
        <p role="status">
          {m.collection_filter_preparing()} {m.collection_filter_retry_later()}
        </p>
      ) : null}
      {empty && !unavailable && status !== 'preparing' && status !== 'unsupported' && status !== 'failed' ? (
        <p className="text-muted-foreground">{filter ? m.collection_filter_no_match() : emptyLabel}</p>
      ) : null}
      {empty && !unavailable && (filter || status === 'failed') ? (
        <a
          className={buttonClass ?? 'inline-flex min-h-10 items-center rounded-lg border border-border px-3'}
          href={collectionFilterAddress(getLocale(), id, {}, {}, {}, filterType)}
        >
          {m.collection_filter_clear()}
        </a>
      ) : null}
    </>
  );
}

/** Shared filter form for curated and dynamic Collection pages. */
export function CollectionFilters({
  id,
  type,
  properties,
  params,
}: {
  id: string;
  type: string;
  properties: CollectionFilterProperty[];
  params: CollectionFilterParams;
}) {
  const locale = getLocale();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    const type = String(form.get('type') ?? '').trim();
    if (type) params.set('type', type);
    form.forEach((value, key) => {
      if (key.startsWith('f.') || (key.startsWith('l.') && String(value))) params.append(key, String(value));
    });
    for (const property of properties.filter((item) => item.datatype === 'quantity')) {
      const from = String(form.get(`range.from.${property.id}`) ?? '').trim();
      const to = String(form.get(`range.to.${property.id}`) ?? '').trim();
      if (from || to) params.set(`r.${property.id}`, `${from},${to}`);
    }
    const query = params.toString();
    window.location.assign(`/${locale}/collections/${encodeURIComponent(id)}${query ? `?${query}` : ''}`);
  }
  if (properties.length === 0) return null;
  return (
    <section className="min-w-0">
      <Menu
        title={m.collection_filters()}
        trigger={
          <Button type="button" aria-label={m.collection_filters()} variant="outline" size="icon">
            <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
          </Button>
        }
        entries={[]}
        content={
          <form
            onSubmit={submit}
            method="get"
            action={`/${locale}/collections/${encodeURIComponent(id)}`}
            className="max-h-[70vh] min-w-0 overflow-y-auto p-4 sm:w-[min(32rem,calc(100vw-2rem))]"
          >
            <FilterFields id={id} type={type} locale={locale} properties={properties} params={params} />
          </form>
        }
      />
    </section>
  );
}

function FilterFields({
  id,
  type,
  locale,
  properties,
  params,
}: {
  id: string;
  type: string;
  locale: string;
  properties: CollectionFilterProperty[];
  params: CollectionFilterParams;
}) {
  return (
    <>
      <input type="hidden" name="type" value={type} />
      <h2 className="mb-4 font-medium">{m.collection_filters()}</h2>
      {properties.map((property) => (
        <fieldset key={property.id} className="mb-4 min-w-0 space-y-2">
          <legend className="text-sm font-medium">
            {property.label}
            {property.unit ? ` (${property.unit})` : ''}
          </legend>
          {property.datatype === 'wikibase-item' ? (
            <ConceptSuggestion
              property={property}
              {...(params.selected[property.id]?.[0] ? { selected: params.selected[property.id]![0]! } : {})}
              {...(params.selectedLabels[property.id] ? { selectedLabel: params.selectedLabels[property.id]! } : {})}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <label className="min-w-0 text-sm">
                {m.collection_filter_from()}
                <input
                  className="block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2"
                  type="number"
                  name={`range.from.${property.id}`}
                  defaultValue={params.ranges[property.id]?.from ?? ''}
                />
              </label>
              <label className="min-w-0 text-sm">
                {m.collection_filter_to()}
                <input
                  className="block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2"
                  type="number"
                  name={`range.to.${property.id}`}
                  defaultValue={params.ranges[property.id]?.to ?? ''}
                />
              </label>
            </div>
          )}
        </fieldset>
      ))}
      <div className="sticky bottom-0 flex flex-wrap gap-2 bg-background py-3 lg:static">
        <button className="min-h-10 rounded-lg bg-primary px-4 text-primary-foreground" type="submit">
          {m.collection_filter_apply()}
        </button>
        <a
          className="inline-flex min-h-10 items-center rounded-lg border border-border px-4"
          href={collectionFilterAddress(locale, id, {}, {}, {}, type)}
        >
          {m.collection_filter_clear()}
        </a>
      </div>
    </>
  );
}

type ConceptSuggestionProps = {
  property: CollectionFilterProperty;
  selected?: string;
  selectedLabel?: string;
};

function ConceptSuggestion(props: ConceptSuggestionProps) {
  if (!props.property.targets?.length)
    return (
      <>
        <input
          className="w-full min-w-0"
          aria-label={props.property.label}
          disabled
          placeholder={m.collection_filter_concept()}
        />
        <p role="status">{m.collection_filter_concepts_unavailable()}</p>
      </>
    );
  return <TargetedConceptSuggestion {...props} targets={props.property.targets} />;
}

function TargetedConceptSuggestion({
  property,
  selected,
  selectedLabel,
  targets,
}: ConceptSuggestionProps & { targets: readonly string[] }) {
  const locale = getLocale();
  const [query, setQuery] = useState(() =>
    selectedLabel && !isIdentifierLabel(selectedLabel, selected ?? '') ? selectedLabel : '',
  );
  const [choices, setChoices] = useState<ConceptChoice[]>([]);
  const [choice, setChoice] = useState<ConceptChoice | null>(null);
  const [value, setValue] = useState(selected ?? '');
  const [initialSelectionResolved, setInitialSelectionResolved] = useState(!selected);
  const [phase, setPhase] = useState<'idle' | 'searching' | 'done' | 'failed'>('idle');
  const [selectionUnavailable, setSelectionUnavailable] = useState(false);
  const initialSelection = selected;
  useEffect(() => {
    const resolvingSelection = Boolean(initialSelection && value === initialSelection && !initialSelectionResolved);
    if (choice && query === choice.label && value === choice.id && !resolvingSelection) {
      setChoices([]);
      setPhase('idle');
      return;
    }
    const searchText = resolvingSelection ? initialSelection : query.trim();
    if (!searchText) {
      setChoices([]);
      setPhase('idle');
      return;
    }
    const controller = new AbortController();
    setPhase('searching');
    const timer = window.setTimeout(
      async () => {
        try {
          const response = await fetch(
            `/api/search/suggestions?q=${encodeURIComponent(searchText)}&locale=${encodeURIComponent(locale)}`,
            { signal: controller.signal },
          );
          if (!response.ok) throw new Error('Suggestions unavailable');
          const result = (await response.json()) as SuggestionResult;
          if (controller.signal.aborted) return;
          const concepts = result.subjects
            .filter((subject) => matchesPropertyTarget(subject, targets))
            .flatMap((subject) => {
              const label = localizedLabel(subject.labels, locale);
              if (!label.text || isIdentifierLabel(label.text, subject.id)) return [];
              const typeLabel = localizedLabel(result.types[subject.type] ?? {}, locale);
              return [
                {
                  id: subject.id,
                  label: label.text,
                  ...(label.lang ? { lang: label.lang } : {}),
                  typeLabel: typeLabel.text,
                  ...(typeLabel.lang ? { typeLang: typeLabel.lang } : {}),
                },
              ];
            })
            .slice(0, 8);
          if (resolvingSelection) {
            const current = concepts.find((item) => item.id === initialSelection);
            if (current) {
              setChoice(current);
              setQuery(current.label);
              setSelectionUnavailable(false);
            } else {
              setChoice(null);
              setSelectionUnavailable(true);
            }
            setInitialSelectionResolved(true);
            setPhase('idle');
            setChoices([]);
            return;
          }
          setChoices(concepts);
          setSelectionUnavailable(false);
          setPhase('done');
        } catch (error) {
          if (controller.signal.aborted) return;
          setChoices([]);
          setPhase('failed');
          if (resolvingSelection) {
            setSelectionUnavailable(true);
            setInitialSelectionResolved(true);
          }
        }
      },
      resolvingSelection ? 0 : 200,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [choice, initialSelection, initialSelectionResolved, locale, query, targets, value]);
  function inputValueChange(text: string, reason: string, isItemPress: boolean) {
    if (isItemPress || reason === 'item-press') return;
    setQuery(text);
    if (choice && text !== choice.label) setChoice(null);
    if (text !== choice?.label) {
      setValue('');
      setSelectionUnavailable(false);
      setInitialSelectionResolved(true);
    }
    setPhase(text.trim() ? 'searching' : 'idle');
  }
  return (
    <div className="relative min-w-0">
      <Combobox
        items={choices}
        filter={null}
        value={choice}
        inputValue={query}
        itemToStringLabel={(item: ConceptChoice) => item.label}
        isItemEqualToValue={(left: ConceptChoice, right: ConceptChoice) => left.id === right.id}
        onInputValueChange={(text, details) => inputValueChange(text, details.reason, details.isItemPress ?? false)}
        onValueChange={(item: ConceptChoice | null) => {
          if (!item) return;
          setChoice(item);
          setValue(item.id);
          setQuery(item.label);
          setInitialSelectionResolved(true);
          setSelectionUnavailable(false);
          setChoices([]);
          setPhase('idle');
        }}
      >
        <ComboboxInput
          aria-label={property.label}
          autoComplete="off"
          placeholder={m.collection_filter_concept()}
          className="w-full min-w-0"
          showTrigger={false}
        />
        <ComboboxContent aria-busy={phase === 'searching'}>
          <ComboboxEmpty>
            {phase === 'searching'
              ? m.collection_filter_searching()
              : phase === 'failed'
                ? m.search_suggestions_failed()
                : query.trim()
                  ? m.search_no_suggestions()
                  : m.collection_filter_concept()}
          </ComboboxEmpty>
          <ComboboxList aria-label={property.label} tabIndex={choices.length ? 0 : -1}>
            {(item: ConceptChoice) => (
              <ComboboxItem key={item.id} value={item} className="items-start">
                <span className="min-w-0 flex-1" lang={item.lang}>
                  {item.label}
                </span>
                {item.typeLabel ? (
                  <span className="text-xs text-muted-foreground" lang={item.typeLang}>
                    {item.typeLabel}
                  </span>
                ) : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      <input type="hidden" name={`l.${property.id}`} value={choice?.label ?? ''} />
      <input type="hidden" name={`f.${property.id}`} value={value} />
      {phase === 'searching' ? <p role="status">{m.collection_filter_searching()}</p> : null}
      {phase === 'failed' ? <p role="status">{m.search_suggestions_failed()}</p> : null}
      {phase === 'done' && query.trim() && choices.length === 0 ? (
        <p role="status">{m.search_no_suggestions()}</p>
      ) : null}
      {selectionUnavailable ? <p role="status">{m.library_subject_unavailable()}</p> : null}
    </div>
  );
}

type ConceptChoice = { id: string; label: string; lang?: string; typeLabel: string; typeLang?: string };

function matchesPropertyTarget(subject: SuggestionResult['subjects'][number], targets: readonly string[] | undefined) {
  if (!targets?.length) return false;
  const subjectTypes = new Set([subject.type, ...(subject.summary?.types ?? [])]);
  return targets.some((target) => subjectTypes.has(target));
}

function isIdentifierLabel(label: string, id: string) {
  return label === id || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(label) || /^[a-z][\w.-]*:[\w.-]+$/i.test(label);
}
