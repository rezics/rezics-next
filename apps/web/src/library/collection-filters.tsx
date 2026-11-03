import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { CollectionFilterParams } from './collection-filter-params';
import type { FilterDocument } from '@rezics/filter';
import { collectionFilterAddress } from './collection-filter-params';
import { CollectionFilterAddressState } from './collection-filter-address-state';
import {
  collectionFacetRequest,
  loadCollectionFacetValues,
  type CollectionFacetLoader,
} from './collection-facet-values';
import { requestLanguages } from '../kernel/languages';
import { Exposure } from '../kernel/exposure';
import { SaveQueryLink } from './saved-query-editor/link';
import { BottomSheet } from '@rezics/ui/bottom-sheet';
import { useIsMobile } from '@rezics/ui/hooks/use-is-mobile';
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@rezics/ui/shadcn/dialog';
import { Button } from '@rezics/ui/shadcn/button';
import { SlidersHorizontalIcon } from 'lucide-react';
import { Refinement, type RefinementData, type RefinementConditions } from '../search/refinement/refinement';
import { MAX_CACHED_FACET_PROPERTIES } from '../search/refinement/facet-continuation';
import { createRangeDraftState, getRangeDraft, updateRangeDraft, type RangeDraftState } from '../search/refinement/range-draft';
import type { RefinementProperty } from '../search/refinement/model';

export type CollectionFilterProperty = {
  id: string;
  label: string;
  datatype: string;
  mode?: RefinementProperty['mode'];
  labels?: Record<string, string>;
  units?: readonly string[];
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
  filterReleaseKey,
  viewerKey = 'anonymous',
  facetLoader,
}: {
  id: string;
  type: string;
  properties: CollectionFilterProperty[];
  params: CollectionFilterParams;
  filterReleaseKey?: string;
  viewerKey?: string;
  facetLoader?: CollectionFacetLoader;
}) {
  const locale = getLocale();
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const refinementProperties = properties.map((property): RefinementProperty => ({
    property: property.id,
    labels: property.labels ?? { [locale]: property.label },
    mode:
      property.mode ??
      (property.datatype === 'quantity' || property.datatype === 'time'
        ? 'range'
        : property.datatype === 'wikibase-item' || property.datatype === 'string'
          ? 'values'
          : 'unsupported'),
    datatype: property.datatype,
    units: (property.units ?? (property.unit ? [property.unit] : [])).slice(0, 1),
  }));
  const initialShown = refinementProperties.slice(0, MAX_CACHED_FACET_PROPERTIES).map((property) => property.property);
  const identity = JSON.stringify({
    id,
    type,
    release: filterReleaseKey ?? JSON.stringify(refinementProperties),
    locale,
    viewer: viewerKey,
    filter: params.document ?? null,
    selected: params.selected,
    ranges: params.ranges,
  });
  const [shown, setShown] = useState(initialShown);
  const [draftConditions, setDraftConditions] = useState(() => collectionConditions(params, refinementProperties));
  const [draftLabels, setDraftLabels] = useState(params.selectedLabels);
  const [rangeDraftState, setRangeDraftState] = useState<RangeDraftState>(() => createRangeDraftState(identity));
  const trigger = useRef<HTMLButtonElement>(null);
  const surfaceId = useId();
  const clearAddress = collectionFilterAddress(locale, id, {}, {}, {}, type, new URLSearchParams(search));
  useEffect(() => {
    setDraftConditions(collectionConditions(params, refinementProperties));
    setDraftLabels(params.selectedLabels);
    setRangeDraftState(createRangeDraftState(identity));
    setShown(initialShown);
  }, [identity]);
  function changeOpen(next: boolean) {
    if (next) {
      setDraftConditions(collectionConditions(params, refinementProperties));
      setDraftLabels(params.selectedLabels);
      setRangeDraftState(createRangeDraftState(identity));
      setShown(initialShown);
    }
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
    for (const property of properties.filter((item) => refinementProperties.find((entry) => entry.property === item.id)?.mode === 'range')) {
      const from = String(form.get(`range.from.${property.id}`) ?? '').trim();
      const to = String(form.get(`range.to.${property.id}`) ?? '').trim();
      const lower = from ? Number(from) : undefined;
      const upper = to ? Number(to) : undefined;
      const time = property.datatype === 'time';
      const invalid =
        (lower !== undefined && (!Number.isFinite(lower) || (time && !Number.isSafeInteger(lower)))) ||
        (upper !== undefined && (!Number.isFinite(upper) || (time && !Number.isSafeInteger(upper)))) ||
        (lower !== undefined && upper !== undefined && lower > upper);
      if (invalid) {
        const current = getRangeDraft(rangeDraftState, identity, property.id, rangeDraft(property, params));
        setRangeDraftState((previous) =>
          updateRangeDraft(previous, identity, property.id, { ...current, invalid: true }),
        );
        return;
      }
      if (from || to)
        ranges[property.id] = {
          ...(lower === undefined ? {} : { from: lower }),
          ...(upper === undefined ? {} : { to: upper }),
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
      <>
        <input type="hidden" name="type" value={type} />
        {Object.entries(draftLabels).map(([property, label]) =>
          label && draftConditions.facetValues[property]?.length ? (
            <input key={property} type="hidden" name={`l.${property}`} value={label} />
          ) : null,
        )}
        <Refinement
          key={identity}
          data={{ key: identity, properties: refinementProperties } satisfies RefinementData}
          conditions={draftConditions}
          query=""
          locale={locale}
          showSummary={false}
          deferNavigation
          perPropertyState
          onConditionsChange={setDraftConditions}
          onValueSelectionChange={(property, values, firstValue, firstLabel) => {
            setDraftLabels((previous) => {
              const next = { ...previous };
              if (!values.length) delete next[property];
              else if (firstLabel) next[property] = firstLabel;
              else if (firstValue !== params.selected[property]?.[0]) delete next[property];
              return next;
            });
          }}
          selectedLabels={draftLabels}
          onShownChange={setShown}
          rangeName={(property, bound) => `range.${bound}.${property}`}
          rangeDraftKey={identity}
          rangeDraftState={rangeDraftState}
          onRangeDraftChange={(property, draft) =>
            setRangeDraftState((previous) => updateRangeDraft(previous, identity, property, draft))
          }
          load={async (facets, signal) => {
            const request = collectionFacetRequest(
              {
                resource: { kind: 'collection', id },
                type,
                release: filterReleaseKey ?? 'unavailable',
                ...(params.document ? { filter: params.document } : {}),
                languages: requestLanguages(locale),
              },
              facets,
            );
            return (facetLoader ?? loadCollectionFacetValues)(request, signal);
          }}
        />
        {properties
          .filter((property) => !shown.includes(property.id) && refinementProperties.find((entry) => entry.property === property.id)?.mode === 'range')
          .map((property) => {
            const draft = getRangeDraft(rangeDraftState, identity, property.id, rangeDraft(property, params));
            return (
              <span key={property.id} hidden>
                <input type="hidden" name={`range.from.${property.id}`} value={draft.lower} />
                <input type="hidden" name={`range.to.${property.id}`} value={draft.upper} />
              </span>
            );
          })}
        <div className="sticky bottom-0 flex flex-wrap gap-2 bg-popover py-3">
          <button className="min-h-11 rounded-lg bg-primary px-4 text-primary-foreground" type="submit">
            {m.collection_filter_apply()}
          </button>
          <a className="inline-flex min-h-11 items-center rounded-lg border border-border px-4" href={clearAddress}>
            {m.collection_filter_clear()}
          </a>
        </div>
      </>
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

function collectionConditions(
  params: CollectionFilterParams,
  properties: RefinementProperty[],
): RefinementConditions {
  const byProperty = new Map(properties.map((property) => [property.property, property]));
  const ranges = Object.fromEntries(
    Object.entries(params.ranges).map(([property, range]) => {
      const definition = byProperty.get(property);
      return [
        property,
        {
          ...(range.from === undefined ? {} : { gte: range.from }),
          ...(range.to === undefined ? {} : { lte: range.to }),
          ...(definition?.datatype === 'quantity' && definition.units[0] ? { unit: definition.units[0] } : {}),
        },
      ];
    }),
  );
  return { facetValues: structuredClone(params.selected), ranges };
}

function rangeDraft(property: CollectionFilterProperty, params: CollectionFilterParams) {
  return {
    lower: params.ranges[property.id]?.from?.toString() ?? '',
    upper: params.ranges[property.id]?.to?.toString() ?? '',
    unit: property.units?.[0] ?? property.unit ?? '',
    invalid: false,
  };
}
