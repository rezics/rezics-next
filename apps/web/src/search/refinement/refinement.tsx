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
import { FacetContinuationLedger } from './facet-continuation';
import { refinementHref, type RefinementConditions, type RefinementProperty } from './model';
import { PropertyPicker } from './property-picker';
import { type FacetPage, type FacetState, type RequestedFacet } from './request';

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
  const [shown, setShown] = useState(data.properties.slice(0, 8).map((entry) => entry.property));
  const [pages, setPages] = useState<FacetPage['facets']>(
    data.initial?.status === 'ready' ? data.initial.page.facets : [],
  );
  const [state, setState] = useState(data.initial);
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const continuations = useRef(new FacetContinuationLedger(queryIdentity));
  const lastRead = useRef<{ facets: RequestedFacet[]; more?: string | undefined } | undefined>(undefined);
  const waiting = useSearchRetryWait(state && state.status !== 'ready' ? state.retryAt : undefined);
  useEffect(() => () => active.current?.abort(), []);
  const href = (next: RefinementConditions) => refinementHref(locale, query, next, sort);
  const label = (labels: Record<string, string>) => localizedLabel(labels, locale).text;
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

  function stopRepeatedContinuation(property: string) {
    setPages((current) => current.map((page) => (page.property === property ? { ...page, next: null } : page)));
    lastRead.current = undefined;
    setState({ status: 'restart', code: 'repeated_facet_continuation' });
  }

  async function readRequested(facets: RequestedFacet[], more?: string) {
    if (!isCurrent()) return;
    const repeatedRequest = facets.find(
      (facet) => facet.cursor !== undefined && continuations.current.has(facet.property, facet.cursor),
    );
    if (repeatedRequest) {
      stopRepeatedContinuation(repeatedRequest.property);
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
        const repeated = result.page.facets.find((facet) => {
          const request = facets.find((entry) => entry.property === facet.property);
          return continuations.current.repeats(facet.property, request?.cursor, facet.next);
        });
        if (repeated) {
          stopRepeatedContinuation(repeated.property);
          return;
        }
        const next = [...pages];
        for (const facet of result.page.facets) {
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
          const combined = {
            ...facet,
            values: more === facet.property && previous ? [...previous.values, ...facet.values] : facet.values,
          };
          if (index >= 0) next[index] = combined;
          else next.push(combined);
        }
        for (const facet of result.page.facets) {
          const request = facets.find((entry) => entry.property === facet.property);
          if (request?.cursor !== undefined) continuations.current.consume(facet.property, request.cursor);
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
            <ul className="flex flex-wrap gap-2" aria-label={m.refinement_selected()}>
              {selected.map(({ property, value }) => {
                const text =
                  label(
                    pages.find((entry) => entry.property === property)?.values.find((entry) => entry.value === value)
                      ?.labels ?? {},
                  ) || m.refinement_selected_value();
                const propertyName =
                  property === 'type'
                    ? m.search_subject_types()
                    : label(data.properties.find((entry) => entry.property === property)?.labels ?? {});
                const chip = propertyName ? `${propertyName}: ${text}` : text;
                const values = conditions.facetValues[property]!.filter((entry) => entry !== value);
                return (
                  <li key={`${property}:${value}`}>
                    <a
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                      aria-label={m.refinement_remove({ value: chip })}
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
                    aria-label={m.refinement_remove({
                      value:
                        label(data.properties.find((entry) => entry.property === property)?.labels ?? {}) ||
                        m.refinement_range(),
                    })}
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
              {m.refinement_clear()}
            </a>
          </>
        )}
      <PropertyPicker
        properties={data.properties}
        locale={locale}
        onSelect={(property) => {
          setShown((previous) => [property, ...previous.filter((entry) => entry !== property)].slice(0, 8));
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
              ? m.refinement_refused()
              : state.status === 'preparing'
                ? m.search_reader_facets_not_ready()
                : state.status === 'restart'
                  ? m.refinement_restart()
                  : m.search_reader_facets_unavailable()}
          </p>
          {waiting && state.status !== 'refused' && <p>{m.search_recovery_wait()}</p>}
          {state.status === 'restart' ? (
            <a href={href(conditions)} className={buttonVariants({ variant: 'link', size: 'sm' })}>
              {m.search_facet_retry()}
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
                {m.search_facet_retry()}
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
        const title = definition.mode === 'types' ? m.search_subject_types() : label(definition.labels) || property;
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
              <p className="text-sm text-muted-foreground">{m.search_subject_types_help()}</p>
            )}
            {definition.mode === 'range' ? (
              <RangeControl definition={definition} conditions={conditions} href={href} navigate={navigate} />
            ) : definition.mode === 'unsupported' ? (
              <p className="text-sm text-muted-foreground">{m.refinement_unsupported()}</p>
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
                    <span className="min-w-0 break-words">{label(entry.labels) || m.refinement_selected_value()}</span>
                  </Label>
                ))}
                {page?.values.length === 0 && state?.status === 'ready' && (
                  <p className="text-sm text-muted-foreground">{m.refinement_no_values()}</p>
                )}
                {page?.next && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void read([property], property)}
                  >
                    {m.refinement_more_values()}
                  </Button>
                )}
                {!page && !failed && (
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void read(shown)}>
                    {m.refinement_load_values()}
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
}: {
  definition: RefinementProperty;
  conditions: RefinementConditions;
  href: (conditions: RefinementConditions) => string;
  navigate: (href: string) => void;
}) {
  const id = useId();
  const range = conditions.ranges?.[definition.property];
  const applied = range !== undefined;
  const committedLower = range?.gte?.toString() ?? '';
  const committedUpper = range?.lte?.toString() ?? '';
  const committedUnit = range?.unit ?? definition.units[0] ?? '';
  const [lower, setLower] = useState(committedLower);
  const [upper, setUpper] = useState(committedUpper);
  const [unit, setUnit] = useState(committedUnit);
  const [invalid, setInvalid] = useState(false);
  const time = definition.datatype === 'time';
  useEffect(() => {
    setLower(committedLower);
    setUpper(committedUpper);
    setUnit(committedUnit);
    setInvalid(false);
  }, [applied, committedLower, committedUpper, committedUnit]);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <Field>
          <FieldLabel htmlFor={`${id}-lower`}>{m.refinement_lower()}</FieldLabel>
          <Input
            id={`${id}-lower`}
            type="number"
            min={time ? -Number.MAX_SAFE_INTEGER : undefined}
            max={time ? Number.MAX_SAFE_INTEGER : undefined}
            step={time ? '1' : 'any'}
            value={lower}
            onChange={(event) => {
              setLower(event.currentTarget.value);
              setInvalid(false);
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-upper`}>{m.refinement_upper()}</FieldLabel>
          <Input
            id={`${id}-upper`}
            type="number"
            min={time ? -Number.MAX_SAFE_INTEGER : undefined}
            max={time ? Number.MAX_SAFE_INTEGER : undefined}
            step={time ? '1' : 'any'}
            value={upper}
            onChange={(event) => {
              setUpper(event.currentTarget.value);
              setInvalid(false);
            }}
          />
        </Field>
      </div>
      {!time && (
        <Field>
          <FieldLabel htmlFor={`${id}-unit`}>{m.refinement_unit()}</FieldLabel>
          <NativeSelect id={`${id}-unit`} value={unit} onChange={(event) => setUnit(event.currentTarget.value)}>
            {definition.units.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      )}
      {time && <p className="text-sm text-muted-foreground">{m.refinement_year_hint()}</p>}
      {invalid && (
        <p role="alert" className="text-sm text-destructive">
          {m.refinement_invalid_range()}
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
            {m.refinement_range_remove_action()}
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
              setInvalid(true);
              return;
            }
            setInvalid(false);
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
          {m.search_apply()}
        </Button>
      </div>
    </div>
  );
}
