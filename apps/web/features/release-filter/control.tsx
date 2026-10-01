import { Button } from '@rezics/ui/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import type { ZoneReleaseFilterSpec } from '@rezics/zone-sdk';
import LocalizedLink from '../shell/localized-link.tsx';
import type { ResolvedField, ResolvedReleaseFilter } from './registry.ts';
import { releaseFilterActive, type ReleaseFilterState } from './state.ts';

// The release filter as a form: native selects and one submit button, so every choice is reachable by keyboard,
// works without script and leaves each filtered view with its own address. The registry names the fields and
// their values (`resolveReleaseFilter`); the Zone adds its words (`ZoneReleaseFilterSpec`); the platform owns
// the control and the query.

/** The options of a field, with the current value kept when the address names one the Zone does not list. */
function optionsOf(field: ResolvedField, current: string | undefined) {
  return current && !field.options.some(option => option.value === current)
    ? [...field.options, { value: current, label: current }] : field.options;
}

/** The Zone's word for a chosen value, or the value itself when the Zone lists no word for it. */
export function chosenLabel(filter: ResolvedReleaseFilter, facet: string, value: string): string {
  return filter.fields.find(field => field.facet === facet)?.options.find(option => option.value === value)?.label
    ?? value;
}

/**
 * One release must meet every chosen condition. The form submits to the browse page with each choice as a URL
 * parameter named by its facet; an unchosen field is sent empty and dropped by the page.
 */
export function ReleaseFilterControl({ spec, filter, state, action, idPrefix = 'release-filter', clearHref }: {
  spec: Pick<ZoneReleaseFilterSpec, 'label' | 'apply' | 'clear'>; filter: ResolvedReleaseFilter;
  state: ReleaseFilterState;
  /** The browse page the form submits to. */
  action: string;
  idPrefix?: string;
  /** The browse page without the filter; shown while a condition is chosen. */
  clearHref: string;
}) {
  const headingId = `${idPrefix}-title`;
  return <form action={action} method="get" aria-labelledby={headingId} data-release-filter=""
    className="grid gap-3 rounded-2xl border border-border/60 bg-card p-4">
    <h2 id={headingId} className="font-semibold text-base">{spec.label}</h2>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {filter.fields.map(field => {
        const id = `${idPrefix}-${field.facet}`;
        const current = state.conditions[field.facet];
        return <div key={field.facet} className="grid min-w-0 gap-1">
          <label htmlFor={id} className="font-medium text-muted-foreground text-xs">{field.label}</label>
          <NativeSelect id={id} name={field.facet} defaultValue={current ?? ''} size="md" className="w-full">
            <NativeSelectOption value="">{field.any}</NativeSelectOption>
            {optionsOf(field, current).map(option => <NativeSelectOption key={option.value} value={option.value}>
              {option.label}</NativeSelectOption>)}
          </NativeSelect>
        </div>;
      })}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit">{spec.apply}</Button>
      {releaseFilterActive(state) ? <LocalizedLink href={clearHref}
        className="rounded-sm text-primary text-sm outline-none underline-offset-4 hover:underline
          focus-visible:ring-2 focus-visible:ring-ring">{spec.clear}</LocalizedLink> : null}
    </div>
  </form>;
}
