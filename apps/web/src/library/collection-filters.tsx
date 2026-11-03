import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { CollectionFilterParams } from './collection-filter-params';
import type { SuggestionResult } from '../search/suggestions';
import type { FilterDocument } from '@rezics/filter';
import { collectionFilterAddress } from './collection-filter-params';
import { CollectionFilterAddressState } from './collection-filter-address-state';
import { Exposure } from '../kernel/exposure';
import { SaveQueryLink } from './saved-query-editor/link';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { useIsMobile } from '@rezics/ui/hooks/use-is-mobile';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@rezics/ui/shadcn/dialog';
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
  const router = useRouter({ warn: false });
  const rejected = status === 'failed' && ignored.length > 0;
  return (
    <>
      {ignored.length && !rejected ? (
        <p role="status">{m.collection_filter_ignored({ filter: ignored.join(', ') })}</p>
      ) : null}
      {status === 'unsupported' ? <p role="status">{m.collection_filter_unsupported()}</p> : null}
      {status === 'failed' && !rejected ? <p role="status">{m.collection_filter_failed()}</p> : null}
      {status === 'preparing' ? (
        <p role="status">
          {m.collection_filter_preparing()} {m.collection_filter_retry_later()}
        </p>
      ) : null}
      {empty && !unavailable && status !== 'preparing' && status !== 'unsupported' && status !== 'failed' ? (
        <p className="text-muted-foreground">{filter ? m.collection_filter_no_match() : emptyLabel}</p>
      ) : null}
      {empty && !unavailable && !rejected && (filter || status === 'failed') ? (
        <a
          className={buttonClass ?? 'inline-flex min-h-10 items-center rounded-lg border border-border px-3'}
          href={collectionFilterAddress(
            getLocale(),
            id,
            {},
            {},
            {},
            filterType,
            new URLSearchParams(router?.state.location.searchStr),
          )}
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
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const surfaceId = useId();
  const clearAddress = collectionFilterAddress(locale, id, {}, {}, {}, type, new URLSearchParams(search));
  function changeOpen(next: boolean) {
    setOpen(next);
    if (!next) requestAnimationFrame(() => trigger.current?.focus());
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selected: Record<string, string[]> = {};
    const labels: Record<string, string> = {};
    const ranges: CollectionFilterParams['ranges'] = {};
    form.forEach((value, key) => {
      if (key.startsWith('f.') && String(value)) (selected[key.slice(2)] ??= []).push(String(value));
      if (key.startsWith('l.') && String(value)) labels[key.slice(2)] = String(value);
    });
    for (const property of properties.filter((item) => item.datatype === 'quantity')) {
      const from = String(form.get(`range.from.${property.id}`) ?? '').trim();
      const to = String(form.get(`range.to.${property.id}`) ?? '').trim();
      if (from || to)
        ranges[property.id] = {
          ...(from ? { from: Number(from) } : {}),
          ...(to ? { to: Number(to) } : {}),
        };
    }
    changeOpen(false);
    window.location.assign(
      collectionFilterAddress(locale, id, selected, ranges, labels, type, new URLSearchParams(search)),
    );
  }
  const form = open ? (
    <form
      onSubmit={submit}
      method="get"
      action={`/${locale}/collections/${encodeURIComponent(id)}`}
      className="min-w-0"
    >
      <FilterFields type={type} properties={properties} params={params} clearAddress={clearAddress} />
    </form>
  ) : null;
  return (
    <section className="min-w-0">
      <CollectionFilterAddressState id={id} type={type} params={params} search={search} />
      <div className="flex flex-wrap items-center gap-2">
        {properties.length ? (
          <>
            <Button
              ref={trigger}
              type="button"
              aria-label={m.collection_filters()}
              aria-haspopup="dialog"
              aria-expanded={open}
              aria-controls={open ? surfaceId : undefined}
              variant="outline"
              size="icon"
              className="min-h-11 min-w-11"
              onClick={() => changeOpen(true)}
            >
              <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
            </Button>
            {mobile ? (
              <BottomSheet open={open} onOpenChange={changeOpen} title={m.collection_filters()}>
                <div id={surfaceId}>{form}</div>
              </BottomSheet>
            ) : (
              <Dialog open={open} onOpenChange={changeOpen}>
                <DialogContent
                  id={surfaceId}
                  finalFocus={trigger}
                  showCloseButton={false}
                  className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto sm:max-w-lg"
                >
                  <DialogHeader className="flex-row items-center justify-between gap-4">
                    <DialogTitle className="min-w-0 break-words">{m.collection_filters()}</DialogTitle>
                    <DialogClose render={<Button type="button" variant="ghost" className="min-h-11" />}>
                      {m.library_collection_cancel()}
                    </DialogClose>
                  </DialogHeader>
                  {form}
                </DialogContent>
              </Dialog>
            )}
          </>
        ) : null}
        {params.document ? (
          <Exposure operation="collection.create">
            <SaveQueryLink
              document={params.document}
              from={collectionFilterAddress(
                locale,
                id,
                params.selected,
                params.ranges,
                params.selectedLabels,
                type,
                new URLSearchParams(search),
              )}
            />
          </Exposure>
        ) : null}
      </div>
    </section>
  );
}

function FilterFields({
  type,
  properties,
  params,
  clearAddress,
}: {
  type: string;
  properties: CollectionFilterProperty[];
  params: CollectionFilterParams;
  clearAddress: string;
}) {
  return (
    <>
      <input type="hidden" name="type" value={type} />
      {properties.map((property) => (
        <fieldset key={property.id} className="mb-4 min-w-0 space-y-2">
          <legend className="max-w-full break-words text-sm font-medium">
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
                  className="block min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-2 py-2"
                  type="number"
                  name={`range.from.${property.id}`}
                  defaultValue={params.ranges[property.id]?.from ?? ''}
                />
              </label>
              <label className="min-w-0 text-sm">
                {m.collection_filter_to()}
                <input
                  className="block min-h-11 w-full min-w-0 rounded-md border border-border bg-background px-2 py-2"
                  type="number"
                  name={`range.to.${property.id}`}
                  defaultValue={params.ranges[property.id]?.to ?? ''}
                />
              </label>
            </div>
          )}
          {params.selected[property.id]?.slice(1).map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-2 break-all text-sm">
              <input type="checkbox" name={`f.${property.id}`} value={value} defaultChecked />
              <code>{value}</code>
            </label>
          ))}
        </fieldset>
      ))}
      <div className="sticky bottom-0 flex flex-wrap gap-2 bg-popover py-3">
        <button className="min-h-11 rounded-lg bg-primary px-4 text-primary-foreground" type="submit">
          {m.collection_filter_apply()}
        </button>
        <a className="inline-flex min-h-11 items-center rounded-lg border border-border px-4" href={clearAddress}>
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
        {props.selected ? <input type="hidden" name={`f.${props.property.id}`} value={props.selected} /> : null}
        {props.selectedLabel ? (
          <input type="hidden" name={`l.${props.property.id}`} value={props.selectedLabel} />
        ) : null}
        <input
          className="min-h-11 w-full min-w-0"
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
          className="min-h-11 w-full min-w-0 [&_input]:min-h-11"
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
              <ComboboxItem key={item.id} value={item} className="min-h-11 items-start">
                <span className="min-w-0 flex-1 break-words" lang={item.lang}>
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
      <input type="hidden" name={`l.${property.id}`} value={value ? (choice?.label ?? selectedLabel ?? '') : ''} />
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
