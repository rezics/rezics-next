import { m } from '../../paraglide/messages.js';
import { getLocale, type Locale } from '../../paraglide/runtime.js';
import type { CollectionTypeOption } from '../collection-presentation';

/** Layout describes this view. Kind remains an exact native Type, or the explicit mixed default. */
export function CollectionPresentationSummary({
  kind,
  types,
  layout,
  dynamic = false,
  locale = getLocale(),
}: {
  kind?: string | null | undefined;
  types?: readonly CollectionTypeOption[] | null | undefined;
  layout?: 'grid' | 'list';
  dynamic?: boolean;
  locale?: string;
}) {
  const options = { locale: locale as Locale };
  const kindLabel = kind
    ? (types?.find((type) => type.id === kind)?.label ?? kind)
    : m.library_collection_mixed_label({}, options);
  return (
    <div
      className="min-w-0 space-y-2"
      data-collection-presentation={dynamic ? 'dynamic' : 'ordered'}
      {...(layout ? { 'data-collection-layout': layout } : {})}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
        <span className="rounded-md bg-muted px-3 py-1.5">
          {dynamic
            ? m.collection_presentation_dynamic({}, options)
            : m.collection_presentation_ordered({}, options)}
        </span>
        {layout ? (
          <span className="rounded-md bg-muted px-3 py-1.5">
            {m.library_layout({}, options)}:{' '}
            {layout === 'grid' ? m.library_layout_grid({}, options) : m.library_layout_list({}, options)}
          </span>
        ) : null}
        <span
          className="min-w-0 rounded-md border border-border px-3 py-1.5 [overflow-wrap:anywhere]"
          data-collection-kind={kind ?? 'mixed'}
        >
          {m.library_collection_kind({}, options)}: {kindLabel}
        </span>
      </div>
      <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
        {dynamic
          ? m.collection_presentation_dynamic_help({}, options)
          : m.collection_presentation_ordered_help({}, options)}
      </p>
      {layout === 'grid' && !dynamic ? (
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {m.collection_presentation_grid_help({}, options)}
        </p>
      ) : null}
      {!kind ? (
        <p className="max-w-3xl text-sm text-muted-foreground">{m.library_collection_mixed_help({}, options)}</p>
      ) : null}
    </div>
  );
}
