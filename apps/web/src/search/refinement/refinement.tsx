import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from '@tanstack/react-router';
import { NativeCheckbox } from '@rezics/ui/native-checkbox';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { XIcon } from 'lucide-react';
import { m } from '../../paraglide/messages.js';
import { localizedLabel } from '../results';
import { useSearchRetryWait } from '../search-recovery-retry';
import { FacetContinuationLedger, MAX_CACHED_FACET_PROPERTIES } from './facet-continuation';
import { refinementHref, type RefinementConditions, type RefinementProperty } from './model';
import { PropertyPicker } from './property-picker';
import { type FacetPage, type FacetState, type RequestedFacet } from './request';
import {
  createRangeDraftState,
  getRangeDraft,
  updateRangeDraft,
  type RangeDraft,
  type RangeDraftState,
} from './range-draft';

export type RefinementData = {
  key: string;
  properties: RefinementProperty[];
  initial?: FacetState;
};
type Load = (facets: RequestedFacet[], signal: AbortSignal) => Promise<FacetState>;
type RefinementProps = {
  data: RefinementData;
  conditions: RefinementConditions;
  query: string;
  locale: string;
  sort?: 'rating';
  load: Load;
  showSummary?: boolean;
  onNavigate?: (href: string) => void;
  rangeDraftKey?: string;
  rangeDraftState?: RangeDraftState;
  onRangeDraftChange?: (property: string, draft: RangeDraft) => void;
};

/** Compose existing native fields and checkboxes inside the page's shared desktop/phone Filters surface. */
export function Refinement(props: RefinementProps) {
  const queryIdentity = JSON.stringify([
    props.data.key,
    refinementHref(props.locale, props.query, props.conditions, props.sort),
  ]);
  const currentIdentity = useRef(queryIdentity);
  currentIdentity.current = queryIdentity;
  return (
    <RefinementInstance
      key={queryIdentity}
      {...props}
      queryIdentity={queryIdentity}
      isCurrent={() => currentIdentity.current === queryIdentity}
    />
  );
}

function RefinementInstance({
  data,
  conditions,
  query,
  locale,
  sort,
  load,
  showSummary = true,
  onNavigate,
  rangeDraftKey,
  rangeDraftState: suppliedRangeDraftState,
  onRangeDraftChange,
  queryIdentity,
  isCurrent,
}: RefinementProps & { queryIdentity: string; isCurrent: () => boolean }) {
  const id = useId();
  const router = useRouter({ warn: false });
  const navigate =
    onNavigate ??
    ((href: string) => {
      void router?.navigate({ href });
    });
  const initialShown = data.properties.slice(0, MAX_CACHED_FACET_PROPERTIES).map((entry) => entry.property);
  const [shown, setShown] = useState(initialShown);
  const shownRef = useRef(initialShown);
  const [pages, setPages] = useState<FacetPage['facets']>(
    data.initial?.status === 'ready'
      ? data.initial.page.facets.filter((facet) => initialShown.includes(facet.property))
      : [],
  );
  const [state, setState] = useState(data.initial);
  const draftKey = rangeDraftKey ?? queryIdentity;
  const [localRangeDraftState, setLocalRangeDraftState] = useState(() => createRangeDraftState(draftKey));
  const rangeDraftState = suppliedRangeDraftState ?? localRangeDraftState;
  const changeRangeDraft =
    onRangeDraftChange ??
    ((property: string, draft: RangeDraft) =>
      setLocalRangeDraftState((previous) => updateRangeDraft(previous, draftKey, property, draft)));
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const continuations = useRef(new FacetContinuationLedger(queryIdentity));
  continuations.current.retain(shown);
  const lastRead = useRef<{ facets: RequestedFacet[]; more?: string | undefined } | undefined>(undefined);
  const waiting = useSearchRetryWait(state && state.status !== 'ready' ? state.retryAt : undefined);
  useEffect(() => () => active.current?.abort(), []);
  const href = (next: RefinementConditions) => refinementHref(locale, query, next, sort);
  const label = (labels: Record<string, string>) => localizedLabel(labels, locale).text;
  const options = { locale: locale as never };
  const selected = Object.entries(conditions.facetValues).flatMap(([property, values]) =>
    values.map((value) => ({ property, value })),
  );
  const failed = state && state.status !== 'ready';
  const disabled =
    busy ||
    state?.status === 'unavailable' ||
    state?.status === 'refused' ||
    state?.status === 'restart' ||
    state?.status === 'preparing';

  async function read(properties: string[], more?: string) {
    const facets = properties
      .filter((property) =>
        data.properties.some(
          (entry) => entry.property === property && (entry.mode === 'values' || entry.mode === 'types'),
        ),
      )
      .map((property): RequestedFacet => {
        const cursor = more === property ? pages.find((entry) => entry.property === property)?.next : undefined;
        return { property, size: 10, ...(cursor === undefined || cursor === null ? {} : { cursor }) };
      });
    if (!facets.length) return;
    return readRequested(facets, more);
  }

  function stopContinuation(property: string, code = 'repeated_facet_continuation') {
    setPages((current) => current.map((page) => (page.property === property ? { ...page, next: null } : page)));
    lastRead.current = undefined;
    setState({ status: 'restart', code });
  }

  async function readRequested(facets: RequestedFacet[], more?: string) {
    if (!isCurrent()) return;
    const repeatedRequest = facets.find(
      (facet) => facet.cursor !== undefined && continuations.current.has(facet.property, facet.cursor),
    );
    if (repeatedRequest) {
      stopContinuation(repeatedRequest.property);
      return;
    }
    const exhaustedRequest = facets.find(
      (facet) => facet.cursor !== undefined && continuations.current.exhausted(facet.property),
    );
    if (exhaustedRequest) {
      stopContinuation(exhaustedRequest.property, 'facet_window_limit');
      return;
    }
    lastRead.current = { facets, more };
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    try {
      const result = await load(facets, controller.signal);
      if (controller.signal.aborted || !isCurrent()) return;
      if (result.status === 'ready') {
        const returned = result.page.facets.filter((facet) => shownRef.current.includes(facet.property));
        const repeated = returned.find((facet) => {
          const request = facets.find((entry) => entry.property === facet.property);
          return continuations.current.repeats(facet.property, request?.cursor, facet.next);
        });
        if (repeated) {
          stopContinuation(repeated.property);
          return;
        }
        const next = pages.filter((page) => shownRef.current.includes(page.property));
        for (const facet of returned) {
          const index = next.findIndex((entry) => entry.property === facet.property);
          const previous = index >= 0 ? next[index] : undefined;
          if (
            more === facet.property &&
            previous &&
            facet.values.some((entry) => previous.values.some((old) => old.value === entry.value))
          ) {
            setState({ status: 'unavailable', code: 'invalid_facet_response' });
            return;
          }
          if (index >= 0) next[index] = facet;
          else next.push(facet);
        }
        for (const facet of returned) {
          const request = facets.find((entry) => entry.property === facet.property);
          if (request?.cursor !== undefined) continuations.current.consume(facet.property, request.cursor);
        }
        const exhausted = returned.find(
          (facet) => facet.next !== null && continuations.current.exhausted(facet.property),
        );
        if (exhausted) {
          setPages(next.map((page) => (page.property === exhausted.property ? { ...page, next: null } : page)));
          lastRead.current = undefined;
          setState({ status: 'restart', code: 'facet_window_limit' });
          return;
        }
        setPages(next);
        lastRead.current = undefined;
      }
      setState(result);
    } catch (error) {
      if (!controller.signal.aborted && isCurrent())
        setState({ status: 'unavailable', code: error instanceof Error ? error.name : 'transport_error' });
    } finally {
      if (!controller.signal.aborted && isCurrent()) setBusy(false);
    }
  }

  return (
    <div
      className="min-w-0 space-y-4"
      aria-busy={busy}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
        if (
          (!onNavigate && !router) ||
          !anchor ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigate(anchor.getAttribute('href')!);
      }}
    >
      {showSummary &&
        (selected.length > 0 || Object.keys(conditions.ranges ?? {}).length > 0 || conditions.condition) && (
          <>
            <ul className="flex flex-wrap gap-2" aria-label={m.refinement_selected({}, options)}>
              {selected.map(({ property, value }) => {
                const text =
                  label(
                    pages.find((entry) => entry.property === property)?.values.find((entry) => entry.value === value)
                      ?.labels ?? {},
                  ) || m.refinement_selected_value({}, options);
                const propertyName =
                  property === 'type'
                    ? m.search_subject_types({}, options)
                    : label(data.properties.find((entry) => entry.property === property)?.labels ?? {});
                const chip = propertyName ? `${propertyName}: ${text}` : text;
                const values = conditions.facetValues[property]!.filter((entry) => entry !== value);
                return (
                  <li key={`${property}:${value}`}>
                    <a
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      aria-label={m.refinement_remove({ value: chip }, options)}
                      href={href({ ...conditions, facetValues: { ...conditions.facetValues, [property]: values } })}
                    >
                      <span className="max-w-44 truncate">{chip}</span>
                      <XIcon aria-hidden="true" className="size-3" />
                    </a>
                  </li>
                );
              })}
              {Object.entries(conditions.ranges ?? {}).map(([property, range]) => (
                <li key={property}>
                  <a
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    aria-label={m.refinement_remove(
                      {
                        value:
                          label(data.properties.find((entry) => entry.property === property)?.labels ?? {}) ||
                          m.refinement_range({}, options),
                      },
                      options,
                    )}
                    href={href({
                      ...conditions,
                      ranges: Object.fromEntries(
                        Object.entries(conditions.ranges ?? {}).filter(([key]) => key !== property),
                      ),
                    })}
                  >
                    {label(data.properties.find((entry) => entry.property === property)?.labels ?? {})}:{' '}
                    {range.gte ?? '…'} – {range.lte ?? '…'} {range.unit}
                    <XIcon aria-hidden="true" className="size-3" />
                  </a>
                </li>
              ))}
            </ul>
            <a
              className={buttonVariants({ variant: 'link', size: 'sm' })}
              href={href({
                ...(conditions.type ? { type: conditions.type } : {}),
                ...(conditions.kinds ? { kinds: conditions.kinds } : {}),
                ...(conditions.languages ? { languages: conditions.languages } : {}),
                ...(conditions.filter ? { filter: conditions.filter } : {}),
                facetValues: {},
              })}
            >
              {m.refinement_clear({}, options)}
            </a>
          </>
        )}
      <PropertyPicker
        properties={data.properties}
        locale={locale}
        onSelect={(property) => {
          const nextShown = [property, ...shownRef.current.filter((entry) => entry !== property)].slice(
            0,
            MAX_CACHED_FACET_PROPERTIES,
          );
          shownRef.current = nextShown;
          setShown(nextShown);
          setPages((current) => current.filter((page) => nextShown.includes(page.property)));
          continuations.current.retain(nextShown);
          if (!pages.some((entry) => entry.property === property)) void read([property]);
        }}
      />
      {failed && (
        <div
          role={state.status === 'preparing' ? 'status' : 'alert'}
          className="space-y-2 text-sm text-muted-foreground"
        >
          <p>
            {state.status === 'refused'
              ? m.refinement_refused({}, options)
              : state.status === 'preparing'
                ? m.search_reader_facets_not_ready({}, options)
                : state.status === 'restart'
                  ? m.refinement_restart({}, options)
                  : m.search_reader_facets_unavailable({}, options)}
          </p>
          {waiting && state.status !== 'refused' && <p>{m.search_recovery_wait({}, options)}</p>}
          {state.status === 'restart' ? (
            <a href={href(conditions)} className={buttonVariants({ variant: 'link', size: 'sm' })}>
              {m.search_facet_retry({}, options)}
            </a>
          ) : (
            state.status !== 'refused' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || waiting}
                onClick={() => {
                  const attempt = lastRead.current;
                  void (attempt ? readRequested(attempt.facets, attempt.more) : read(shown));
                }}
              >
                {m.search_facet_retry({}, options)}
              </Button>
            )
          )}
        </div>
      )}
      {selected
        .filter(
          ({ property, value }) =>
            disabled ||
            !shown.includes(property) ||
            !pages.find((entry) => entry.property === property)?.values.some((entry) => entry.value === value),
        )
        .map(({ property, value }) => (
          <input key={`${property}:${value}`} type="hidden" name={`f.${property}`} value={value} />
        ))}
      {shown.map((property) => {
        const definition = data.properties.find((entry) => entry.property === property)!;
        const page = pages.find((entry) => entry.property === property);
        const title =
          definition.mode === 'types' ? m.search_subject_types({}, options) : label(definition.labels) || property;
        return (
          <FieldSet
            key={property}
            className="min-w-0 gap-2 border-t border-border/60 pt-4"
            disabled={
              busy ||
              state?.status === 'refused' ||
              state?.status === 'restart' ||
              state?.status === 'preparing' ||
              (definition.mode !== 'range' && disabled)
            }
          >
            <FieldLegend variant="label">{title}</FieldLegend>
            {definition.mode === 'types' && (
              <p className="text-sm text-muted-foreground">{m.search_subject_types_help({}, options)}</p>
            )}
            {definition.mode === 'range' ? (
              <RangeControl
                definition={definition}
                conditions={conditions}
                href={href}
                navigate={navigate}
                locale={locale}
                draft={getRangeDraft(rangeDraftState, draftKey, definition.property, {
                  lower: conditions.ranges?.[definition.property]?.gte?.toString() ?? '',
                  upper: conditions.ranges?.[definition.property]?.lte?.toString() ?? '',
                  unit: conditions.ranges?.[definition.property]?.unit ?? definition.units[0] ?? '',
                  invalid: false,
                })}
                onDraftChange={(draft) => changeRangeDraft(definition.property, draft)}
              />
            ) : definition.mode === 'unsupported' ? (
              <p className="text-sm text-muted-foreground">{m.refinement_unsupported({}, options)}</p>
            ) : (
              <>
                {page?.values.map((entry, index) => (
                  <Label
                    key={entry.value}
                    htmlFor={`${id}-${property}-${index}`}
                    className="min-h-9 items-start gap-2 font-normal"
                  >
                    <NativeCheckbox
                      id={`${id}-${property}-${index}`}
                      name={`f.${property}`}
                      value={entry.value}
                      checked={conditions.facetValues[property]?.includes(entry.value) || false}
                      onChange={(event) => {
                        if (!onNavigate && !router) {
                          event.currentTarget.form?.requestSubmit();
                          return;
                        }
                        const values = conditions.facetValues[property] ?? [];
                        navigate(
                          href({
                            ...conditions,
                            facetValues: {
                              ...conditions.facetValues,
                              [property]: event.currentTarget.checked
                                ? [...values, entry.value]
                                : values.filter((value) => value !== entry.value),
                            },
                          }),
                        );
                      }}
                    />
                    <span className="min-w-0 break-words">
                      {label(entry.labels) || m.refinement_selected_value({}, options)}
                    </span>
                  </Label>
                ))}
                {page?.values.length === 0 && state?.status === 'ready' && (
                  <p className="text-sm text-muted-foreground">{m.refinement_no_values({}, options)}</p>
                )}
                {page?.next && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void read([property], property)}
                  >
                    {m.refinement_more_values({}, options)}
                  </Button>
                )}
                {!page && !failed && (
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void read(shown)}>
                    {m.refinement_load_values({}, options)}
                  </Button>
                )}
              </>
            )}
          </FieldSet>
        );
      })}
    </div>
  );
}

function RangeControl({
  definition,
  conditions,
  href,
  navigate,
  locale,
  draft,
  onDraftChange,
}: {
  definition: RefinementProperty;
  conditions: RefinementConditions;
  href: (conditions: RefinementConditions) => string;
  navigate: (href: string) => void;
  locale: string;
  draft: RangeDraft;
  onDraftChange: (draft: RangeDraft) => void;
}) {
  const id = useId();
  const options = { locale: locale as never };
  const range = conditions.ranges?.[definition.property];
  const applied = range !== undefined;
  const { lower, upper, unit, invalid } = draft;
  const time = definition.datatype === 'time';
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor={`${id}-lower`}>{m.refinement_lower({}, options)}</FieldLabel>
          <Input
            id={`${id}-lower`}
            type="number"
            min={time ? -Number.MAX_SAFE_INTEGER : undefined}
            max={time ? Number.MAX_SAFE_INTEGER : undefined}
            step={time ? '1' : 'any'}
            value={lower}
            onChange={(event) => {
              onDraftChange({ ...draft, lower: event.currentTarget.value, invalid: false });
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-upper`}>{m.refinement_upper({}, options)}</FieldLabel>
          <Input
            id={`${id}-upper`}
            type="number"
            min={time ? -Number.MAX_SAFE_INTEGER : undefined}
            max={time ? Number.MAX_SAFE_INTEGER : undefined}
            step={time ? '1' : 'any'}
            value={upper}
            onChange={(event) => {
              onDraftChange({ ...draft, upper: event.currentTarget.value, invalid: false });
            }}
          />
        </Field>
      </div>
      {!time && (
        <Field>
          <FieldLabel htmlFor={`${id}-unit`}>{m.refinement_unit({}, options)}</FieldLabel>
          <NativeSelect
            id={`${id}-unit`}
            value={unit}
            onChange={(event) => onDraftChange({ ...draft, unit: event.currentTarget.value })}
          >
            {definition.units.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
      {time && <p className="text-sm text-muted-foreground">{m.refinement_year_hint({}, options)}</p>}
      {invalid && (
        <p role="alert" className="text-sm text-destructive">
          {m.refinement_invalid_range({}, options)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {applied && (
          <a
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            href={href({
              ...conditions,
              ranges: Object.fromEntries(
                Object.entries(conditions.ranges ?? {}).filter(([property]) => property !== definition.property),
              ),
            })}
          >
            {m.refinement_range_remove_action({}, options)}
          </a>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!time && !unit}
          onClick={() => {
            const gte = lower === '' ? undefined : Number(lower);
            const lte = upper === '' ? undefined : Number(upper);
            if (
              (gte === undefined && lte === undefined) ||
              [gte, lte].some(
                (value) => value !== undefined && (!Number.isFinite(value) || (time && !Number.isSafeInteger(value))),
              ) ||
              (gte !== undefined && lte !== undefined && gte > lte)
            ) {
              onDraftChange({ ...draft, invalid: true });
              return;
            }
            onDraftChange({ ...draft, invalid: false });
            navigate(
              href({
                ...conditions,
                ranges: {
                  ...conditions.ranges,
                  [definition.property]: {
                    ...(gte !== undefined ? { gte } : {}),
                    ...(lte !== undefined ? { lte } : {}),
                    ...(!time ? { unit } : {}),
                  },
                },
              }),
            );
          }}
        >
          {m.search_apply({}, options)}
        </Button>
      </div>
    </div>
  );
}
