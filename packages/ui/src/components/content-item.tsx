import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../utils.ts';
import { ListRow, ListRowControl, ListRowLink } from './list-row.tsx';

export interface ContentItemProps extends Omit<HTMLAttributes<HTMLLIElement>, 'title' | 'children'> {
  title: string;
  href?: string;
  titleLang?: string;
  headingLevel?: 2 | 3 | 4;
  visual?: ReactNode;
  context?: ReactNode;
  metadata?: ReactNode;
  preview?: ReactNode;
  state?: ReactNode;
  actions?: ReactNode;
  trailing?: ReactNode;
  forceOverlay?: boolean;
}

function hasSlot(value: ReactNode): boolean {
  return value !== null && value !== undefined && typeof value !== 'boolean';
}

/** A semantic content-list item built on the shared hover, focus and press behavior. */
export function ContentItem({
  title,
  href,
  titleLang,
  headingLevel = 2,
  visual,
  context,
  metadata,
  preview,
  state,
  actions,
  trailing,
  forceOverlay = false,
  className,
  ...liProps
}: ContentItemProps) {
  const titleId = useId();
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';
  const hasRail = hasSlot(state) || hasSlot(actions) || hasSlot(trailing);

  return (
    <ListRow
      {...liProps}
      forceOverlay={forceOverlay}
      className={cn(
        'flex min-w-0 items-start gap-3 py-3 motion-reduce:before:transition-none sm:gap-4 sm:py-4',
        className,
      )}
    >
      {href !== undefined && (
        <ListRowLink href={href} lang={titleLang} aria-labelledby={titleId}>
          {title}
        </ListRowLink>
      )}
      {hasSlot(visual) && (
        <div
          data-content-item-slot="visual"
          className="shrink-0 [&_button]:relative [&_button]:z-10"
        >
          {visual}
        </div>
      )}
      <div className="min-w-0 flex-1 sm:grid sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-x-4">
        <div className="min-w-0">
          {hasSlot(context) && (
            <div
              data-content-item-slot="context"
              className="mb-2 text-[13px] leading-snug text-muted-foreground sm:text-sm"
            >
              {context}
            </div>
          )}
          <Heading
            id={titleId}
            lang={titleLang}
            data-content-item-slot="title"
            className="line-clamp-2 text-[17px] leading-snug font-semibold sm:text-lg md:text-xl sm:line-clamp-1"
          >
            {title}
          </Heading>
          {hasSlot(metadata) && (
            <ListRowControl
              data-content-item-slot="metadata"
              className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-snug text-muted-foreground sm:text-sm"
            >
              {metadata}
            </ListRowControl>
          )}
          {hasSlot(preview) && (
            <div data-content-item-slot="preview" className="mt-2 min-w-0 text-sm leading-relaxed">
              {preview}
            </div>
          )}
        </div>
        {hasRail && (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 sm:col-start-2 sm:row-start-1 sm:mt-0 sm:justify-end">
            {hasSlot(state) && (
              <ListRowControl
                data-content-item-slot="state"
                className={cn(
                  'min-w-0',
                  '[&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:px-2',
                  '[&_button]:min-h-11 [&_button]:min-w-11',
                )}
              >
                {state}
              </ListRowControl>
            )}
            {hasSlot(actions) && (
              <ListRowControl
                data-content-item-slot="actions"
                className={cn(
                  'flex min-h-11 flex-wrap items-center gap-2',
                  '[&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:px-2',
                  '[&_button]:min-h-11 [&_button]:min-w-11',
                )}
              >
                {actions}
              </ListRowControl>
            )}
            {hasSlot(trailing) && (
              <ListRowControl
                data-content-item-slot="trailing"
                className={cn(
                  'flex items-center gap-2',
                  '[&_a]:inline-flex [&_a]:min-h-11 [&_a]:items-center [&_a]:px-2',
                  '[&_button]:min-h-11 [&_button]:min-w-11',
                )}
              >
                {trailing}
              </ListRowControl>
            )}
          </div>
        )}
      </div>
    </ListRow>
  );
}
