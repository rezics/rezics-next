import { Button } from '@rezics/ui/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/native-select';
import type { ZoneReleaseField, ZoneReleaseFilterSpec } from '@rezics/zone-sdk';
import { type ReleaseField, releaseFields, releaseFilterActive, type ReleaseFilterState,
  releaseParams } from './state.ts';
import LocalizedLink from '../shell/localized-link.tsx';

// The release filter as a form: native selects and one submit button, so every choice is reachable
// by keyboard, works without script and leaves each filtered view with its own address. The Zone
// names the fields and values (`ZoneReleaseFilterSpec`); the platform owns the control and the query.

function fieldOf(spec: ZoneReleaseFilterSpec, field: ReleaseField): ZoneReleaseField | undefined {
  return spec[field];
}

/** The options of a field, with the current value kept when the address names one the Zone does not list. */
function optionsOf(field: ZoneReleaseField, current: string | null) {
  return current && !field.options.some(option => option.value === current)
    ? [...field.options, { value: current, label: current }] : field.options;
}

/** The Zone's word for a chosen value, or the value itself when the Zone lists no word for it. */
export function chosenLabel(spec: ZoneReleaseFilterSpec, field: ReleaseField, value: string): string {
  return fieldOf(spec, field)?.options.find(option => option.value === value)?.label ?? value;
}

/**
 * One release must meet every chosen condition. The form submits to the browse page with the chosen
 * values as URL parameters; an unchosen field is sent empty and dropped by the page.
 */
export function ReleaseFilterControl({ spec, state, action, idPrefix = 'release-filter', clearHref }: {
  spec: ZoneReleaseFilterSpec; state: ReleaseFilterState;
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
      {releaseFields.map(name => {
        const field = fieldOf(spec, name);
        if (!field) return null;
        const id = `${idPrefix}-${name}`;
        const current = state[name];
        return <div key={name} className="grid min-w-0 gap-1">
          <label htmlFor={id} className="font-medium text-muted-foreground text-xs">{field.label}</label>
          <NativeSelect id={id} name={releaseParams[name]} defaultValue={current ?? ''} size="md" className="w-full">
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
