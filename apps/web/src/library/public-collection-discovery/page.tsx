import { useId } from 'react';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { publicCollectionDirectoryHref } from '../../search/contracts/collection-directory';
import type { FormEvent, MouseEvent, Ref, ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { PageHeading } from '../../shell/page-heading';
import { m } from '../../paraglide/messages.js';
import { locales } from '../../paraglide/runtime.js';
import type { PublicCollectionDiscoveryState } from './read';
import type { Coordinate, Movement } from './window-navigation';
import {
  continuePublicCollectionDirectory,
  parsePublicCollectionDirectoryAddress,
  selectPublicCollectionDirectory,
  type PublicCollectionDirectorySelection,
} from '../../search/contracts/collection-directory';

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

export function PublicCollectionDiscoveryPage<Row extends { id: string }>({
  state,
  renderCollection,
  locale,
  selection = {},
  cursor,
  continuation = cursor !== undefined,
  retrying = false,
  onRetry,
  onSelect,
  headingRef,
  navigation,
}: {
  state: PublicCollectionDiscoveryState<Row>;
  renderCollection: (collection: Row, locale: string) => ReactNode;
  locale: string;
  selection?: PublicCollectionDirectorySelection;
  cursor?: string;
  continuation?: boolean;
  retrying?: boolean;
  onRetry: () => void;
  onSelect: (selection: PublicCollectionDirectorySelection) => void;
  headingRef?: Ref<HTMLHeadingElement>;
  navigation?: {
    previous?: Coordinate;
    hasPrevious: boolean;
    pending: boolean;
    href: (coordinate: Coordinate) => string;
    move: (event: MouseEvent<HTMLAnchorElement>, movement: Movement, coordinate: Coordinate) => void;
  };
}) {
  const orderSelectId = useId();
  const options = messageOptions(locale);
  const controlClass =
    'inline-flex min-h-11 min-w-11 max-w-full items-center justify-center rounded-md border border-input bg-background px-3 py-2 text-center text-sm font-medium text-primary underline-offset-4 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring whitespace-normal';
  const hrefFor = (coordinate: Coordinate) =>
    navigation?.href(coordinate) ??
    publicCollectionDirectoryHref(locale, continuePublicCollectionDirectory(selection, coordinate ?? undefined));
  const applySelection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = parsePublicCollectionDirectoryAddress({
      presentationKind: form.get('presentationKind'),
      curator: form.get('curator'),
      subject: form.get('subject'),
      order: form.get('order'),
    });
    if (parsed.state === 'ready') onSelect(selectPublicCollectionDirectory(parsed.address));
  };
  const control = (label: string, movement: Movement, coordinate: Coordinate, slot: string) => (
    <a
      data-slot={slot}
      href={hrefFor(coordinate)}
      aria-disabled={navigation?.pending || retrying || undefined}
      onClick={navigation ? (event) => navigation.move(event, movement, coordinate) : undefined}
      className={controlClass}
    >
      {label}
    </a>
  );
  const orderOptions = [
    { value: 'recent', label: m.collection_discovery_order_recent({}, options) },
    { value: 'popular', label: m.collection_discovery_order_popular({}, options) },
  ];
  return (
    <main className="mx-auto w-full min-w-0 max-w-6xl space-y-6 [overflow-wrap:anywhere]">
      <PageHeading ref={headingRef} tabIndex={-1}>
        {m.collection_discovery_heading({}, options)}
      </PageHeading>
      <p className="max-w-3xl text-muted-foreground">{m.collection_discovery_intro({}, options)}</p>
      <form
        data-slot="public-collection-discovery-filters"
        className="grid min-w-0 gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={applySelection}
      >
        <label className="grid min-w-0 gap-1 text-sm font-medium">
          {m.collection_discovery_kind_label({}, options)}
          <input
            name="presentationKind"
            defaultValue={selection.presentationKind ?? ''}
            maxLength={256}
            placeholder={m.collection_discovery_kind_placeholder({}, options)}
            className="min-h-11 min-w-0 rounded-md border border-input bg-background px-3 font-normal"
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-medium">
          {m.collection_discovery_curator_label({}, options)}
          <input
            name="curator"
            defaultValue={selection.curator ?? ''}
            maxLength={36}
            pattern="[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
            placeholder={m.collection_discovery_identity_placeholder({}, options)}
            className="min-h-11 min-w-0 rounded-md border border-input bg-background px-3 font-normal"
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-medium">
          {m.collection_discovery_subject_label({}, options)}
          <input
            name="subject"
            defaultValue={selection.subject ?? ''}
            maxLength={36}
            pattern="[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
            placeholder={m.collection_discovery_identity_placeholder({}, options)}
            className="min-h-11 min-w-0 rounded-md border border-input bg-background px-3 font-normal"
          />
        </label>
        <Field className="grid min-w-0 gap-1 text-sm font-medium">
          <FieldLabel id={`${orderSelectId}-label`} htmlFor={orderSelectId} className="font-medium">
            {m.collection_discovery_order_label({}, options)}
          </FieldLabel>
          <Select<string, false> items={orderOptions} name="order" defaultValue={selection.order ?? 'recent'}>
            <SelectTrigger
              id={orderSelectId}
              aria-labelledby={`${orderSelectId}-label`}
              className="min-h-11 min-w-0 rounded-md border border-input bg-background px-3 font-normal"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              <SelectGroup>
                {orderOptions.map(({ value, label, ...itemProps }) => (
                  <SelectItem key={value ?? ''} value={value} {...itemProps}>
                    {label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" className="min-h-11 w-full">
            {m.collection_discovery_apply({}, options)}
          </Button>
        </div>
      </form>
      {state.status === 'ready' ? (
        <section aria-label={m.collection_discovery_heading({}, options)} className="space-y-5">
          {state.collections.length > 0 ? (
            <ul role="list" data-slot="public-collection-discovery-results" className="space-y-3">
              {state.collections.map((collection) => (
                <li key={collection.id} className="min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-6">
                  {renderCollection(collection, locale)}
                </li>
              ))}
            </ul>
          ) : (
            <p role="status" className="rounded-lg border p-4 text-muted-foreground">
              {cursor || state.next
                ? m.collection_discovery_page_empty({}, options)
                : selection.presentationKind !== undefined || selection.curator || selection.subject
                  ? m.collection_discovery_filtered_empty({}, options)
                  : m.collection_discovery_empty({}, options)}
            </p>
          )}
          <nav aria-label={m.collection_discovery_heading({}, options)} className="flex flex-wrap gap-2">
            {navigation?.hasPrevious
              ? control(m.collection_discovery_previous({}, options), 'previous', navigation.previous!, 'previous')
              : null}
            {cursor !== undefined ? control(m.collection_discovery_first({}, options), 'first', null, 'first') : null}
            {state.next ? control(m.collection_discovery_more({}, options), 'next', state.next, 'continuation') : null}
          </nav>
        </section>
      ) : (
        <section
          role={state.status === 'denied' ? 'alert' : 'status'}
          aria-live={state.status === 'denied' ? 'assertive' : 'polite'}
          className="space-y-4 rounded-lg border p-4"
          data-state={state.status}
        >
          <p>
            {state.status === 'loading'
              ? m.collection_discovery_loading({}, options)
              : state.status === 'preparing' || state.status === 'not-ready'
                ? m.collection_discovery_preparing({}, options)
                : state.status === 'restart'
                  ? m.collection_discovery_restart_required({}, options)
                  : state.status === 'invalid-selection'
                    ? m.collection_discovery_invalid_selection({}, options)
                    : state.status === 'denied'
                      ? continuation
                        ? m.collection_discovery_continuation_refused({}, options)
                        : m.collection_discovery_denied({}, options)
                      : m.collection_discovery_unavailable({}, options)}
          </p>
          {(state.status === 'preparing' ||
            state.status === 'not-ready' ||
            state.status === 'unavailable' ||
            state.status === 'closed') && (
            <Button
              data-slot="retry"
              type="button"
              variant="outline"
              className="min-h-11 min-w-11"
              disabled={retrying}
              onClick={onRetry}
            >
              {m.collection_discovery_retry({}, options)}
            </Button>
          )}
          {continuation ? control(m.collection_discovery_restart({}, options), 'first', null, 'restart') : null}
        </section>
      )}
    </main>
  );
}
